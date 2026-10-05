import type {
  Quote,
  SdkSymbolInfo,
  TradingOptionContract,
  TradingOrder,
  TradingOrderContext,
  TradingOrderDraft,
  TradingOrderPatch,
  TradingPosition,
  TradingPositionPatch,
  TradingState,
} from '@tradescript/pro/sdk'
import { MOCK_PROVIDER } from './identity.js'

export const SYNTHETIC_PIP_SIZE = 0.01
export interface SyntheticQuoteUpdate {
  readonly last: number
  readonly bid: number
  readonly ask: number
  /** Shared executable quantity for this synthetic quote event, across all orders. */
  readonly availableQuantity?: number
}
export interface SyntheticMarket {
  quote(symbol: SdkSymbolInfo): Quote
  subscribe(listener: (symbol: SdkSymbolInfo, quantity?: number) => void): () => void
}
type Working = {
  draft: TradingOrderDraft
  triggered: boolean
  anchor?: number
  closeOnly: boolean
}
type Protection = {
  parent: TradingOrder
  quantity: number
  children: TradingOrder[]
  positionSide?: TradingPosition['side']
}

/** Deterministic local exchange. It makes no claim about native broker execution. */
export function createSyntheticOrderEngine(
  state: TradingState,
  accountId: string,
  market: SyntheticMarket,
  contracts: Map<string, TradingOptionContract>,
  now: () => number,
  publish: () => void,
  maxFillQuantity = Number.POSITIVE_INFINITY,
) {
  if (!(maxFillQuantity > 0)) throw new Error('Synthetic fill quantity must be positive.')
  let sequence = 0
  const working = new Map<string, Working>()
  const protections = new Map<string, Protection>()
  const reversals = new Map<
    string,
    {
      positionId: string
      draft: TradingOrderDraft
      context: TradingOrderContext
    }
  >()
  const history = (order: TradingOrder) => {
    if (state.ordersHistory === undefined) state.ordersHistory = []
    const rows = state.ordersHistory
    const index = rows.findIndex((candidate) => candidate.id === order.id)
    if (index < 0) rows.push(structuredClone(order))
    else rows[index] = structuredClone(order)
  }
  const orderSymbol = (draft: Pick<TradingOrderDraft, 'symbol' | 'optionLegs'>) =>
    draft.optionLegs?.[0] ? exactOptionSymbol(draft.optionLegs[0].contract) : draft.symbol
  const validateOption = (contract: TradingOptionContract, requireRegistered = false) => {
    const registered =
      contract.brokerContractId === undefined
        ? undefined
        : contracts.get(String(contract.brokerContractId))
    if (contract.brokerContractId !== undefined && !registered)
      throw new Error('Synthetic option identity is not registered.')
    if (registered && !sameOption(registered, contract))
      throw new Error('Synthetic option identity contradicts its registered contract.')
    if (requireRegistered && (!registered || !sameOption(registered, contract)))
      throw new Error('Exact registered option identity is required for option reversal.')
    return registered
  }
  const validate = (draft: TradingOrderDraft, context: TradingOrderContext) => {
    if (
      (draft.accountId ?? context.accountId ?? accountId) !== accountId ||
      (context.accountId !== undefined && context.accountId !== accountId)
    )
      throw new Error('Unknown synthetic account.')
    if (draft.symbol.provider !== MOCK_PROVIDER || draft.symbol.type !== 'stock')
      throw new Error('The local simulator requires a supported synthetic underlying instrument.')
    if (draft.side !== 'buy' && draft.side !== 'sell')
      throw new Error('Synthetic order side must be buy or sell.')
    if (draft.duration && !['day', 'gtc'].includes(draft.duration.type))
      throw new Error('Synthetic duration must be DAY or GTC.')
    if (!positiveInteger(draft.quantity))
      throw new Error('A positive whole synthetic order quantity is required.')
    if ((draft.optionLegs?.length ?? 0) > 1 || draft.strategyLegs?.length)
      throw new Error(
        'The local simulator supports single-leg options only; strategy execution is unavailable.',
      )
    const leg = draft.optionLegs?.[0]
    if (leg) {
      if (
        leg.quantity !== draft.quantity ||
        leg.side !== draft.side ||
        (leg.ratio ?? 1) !== 1 ||
        leg.contract.underlyingSymbolInfo.provider !== MOCK_PROVIDER
      )
        throw new Error('Synthetic option leg quantity, direction or identity is inconsistent.')
      if (!positive(leg.contract.multiplier))
        throw new Error('Synthetic option multiplier is required.')
      if (
        leg.contract.currency !== 'USD' ||
        leg.contract.multiplier !== 100 ||
        leg.contract.underlying !== leg.contract.underlyingSymbolInfo.ticker ||
        leg.contract.underlyingSymbolInfo.canonicalSymbol !== `mock:${leg.contract.underlying}` ||
        !positive(leg.contract.strike) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(leg.contract.expiration) ||
        !['call', 'put'].includes(leg.contract.right) ||
        !['open', 'close'].includes(leg.positionEffect)
      )
        throw new Error('A complete supported synthetic option identity is required.')
      validateOption(leg.contract)
      if (leg.positionEffect === 'close') {
        const owned = state.positions.find(
          (position) => positionKey(position) === optionIdentity(leg.contract),
        )
        if (
          !owned ||
          (draft.side === 'sell' ? owned.side !== 'long' : owned.side !== 'short') ||
          draft.quantity > owned.quantity
        )
          throw new Error('Option close quantity must match exact owned exposure.')
      }
      if (draft.exits?.levels.length || !['market', 'limit'].includes(draft.type))
        throw new Error('Synthetic option protection supports market and limit orders only.')
      if (leg.price !== undefined && !positive(leg.price))
        throw new Error('Synthetic option price must be positive.')
    }
    if (!['market', 'limit', 'stop', 'stop-limit', 'trailing-stop'].includes(draft.type))
      throw new Error('Unsupported synthetic order type.')
    if (
      (draft.type === 'limit' || draft.type === 'stop-limit') &&
      !positive(draft.price ?? leg?.price)
    )
      throw new Error('A positive synthetic limit price is required.')
    if ((draft.type === 'stop' || draft.type === 'stop-limit') && !positive(draft.stopPrice))
      throw new Error('A positive synthetic stop price is required.')
    if (
      draft.type === 'trailing-stop' &&
      (Number(positive(draft.trailPercent)) + Number(positive(draft.trailingStopPips)) !== 1 ||
        (draft.trailPercent ?? 0) >= 100)
    )
      throw new Error('Exactly one positive synthetic trailing distance is required.')
    if (
      draft.oca &&
      (!draft.oca.groupId.trim() ||
        !['cancel-with-block', 'reduce-with-block', 'reduce-without-block'].includes(
          draft.oca.behavior,
        ))
    )
      throw new Error('Unsupported synthetic OCA behavior.')
    const levels = draft.exits?.levels ?? []
    if (
      levels.length > 10 ||
      new Set(levels.map((level) => level.id)).size !== levels.length ||
      levels.reduce((sum, level) => sum + level.quantity, 0) > draft.quantity
    )
      throw new Error('Synthetic exit quantities and unique levels must fit the entry quantity.')
    for (const level of levels) {
      if (
        !level.id.trim() ||
        !positiveInteger(level.quantity) ||
        (!level.takeProfit && !level.stopLoss)
      )
        throw new Error('A synthetic exit requires an identity, quantity and target or stop.')
      if (level.takeProfit && !positive(level.takeProfit.price))
        throw new Error('Synthetic exit target must be positive.')
      if (level.stopLoss?.kind === 'guaranteed')
        throw new Error('Guaranteed stops are unavailable on the synthetic exchange.')
      if (
        level.stopLoss?.kind === 'fixed' &&
        (!positive(level.stopLoss.triggerPrice) ||
          (level.stopLoss.limitPrice !== undefined && !positive(level.stopLoss.limitPrice)))
      )
        throw new Error('Synthetic exit stop must be positive.')
      if (level.stopLoss?.kind === 'trailing' && !positive(level.stopLoss.trailingPips))
        throw new Error('Synthetic exit trailing distance must be positive.')
    }
    if (
      draft.type === 'market' &&
      !positive(
        leg?.price ??
          (draft.side === 'buy' ? context.ask : context.bid) ??
          context.lastPrice ??
          market.quote(orderSymbol(draft)).last,
      )
    )
      throw new Error('An explicit positive execution price is required.')
  }
  const active = (order: TradingOrder) =>
    order.status === 'working' || order.status === 'partially-filled'
  const validateWorkingReadback = (symbol?: SdkSymbolInfo) => {
    for (const order of state.orders) {
      if (
        active(order) &&
        (!symbol ||
          instrumentIdentity(orderSymbol(working.get(order.id)?.draft ?? order)) ===
            instrumentIdentity(symbol))
      )
        requireSupportedOrder(order)
    }
  }
  const cancel = (order: TradingOrder) => {
    order.status = 'cancelled'
    order.remainingQuantity = 0
    order.updatedAt = now()
    history(order)
    reversals.delete(order.id)
  }
  const refreshProtection = () => {
    const allocated = new Map<string, number>()
    const exposureReserved = new Map<string, number>()
    for (const group of protections.values()) {
      const key = instrumentIdentity(group.parent.symbol)
      const position = state.positions.find(
        (candidate) => instrumentIdentity(candidate.symbol) === key,
      )
      const orientedQuantity =
        position &&
        (group.parent.side === 'buy' ? position.side === 'long' : position.side === 'short')
          ? position.quantity
          : 0
      if (group.positionSide !== undefined) {
        const closed = [...protections.values()]
          .filter((candidate) => candidate.parent.id === group.parent.id)
          .reduce(
            (sum, candidate) =>
              sum +
              candidate.children.reduce((total, child) => total + (child.filledQuantity ?? 0), 0),
            0,
          )
        group.parent.filledQuantity = orientedQuantity + closed
      }
      const prior = allocated.get(group.parent.id) ?? 0
      const assigned = Math.max(
        0,
        Math.min(group.quantity, (group.parent.filledQuantity ?? 0) - prior),
      )
      allocated.set(group.parent.id, prior + group.quantity)
      const closed = group.children.reduce((sum, child) => sum + (child.filledQuantity ?? 0), 0)
      if (group.children.every((child) => child.status === 'cancelled')) continue
      const reserved = exposureReserved.get(key) ?? 0
      const available = Math.max(0, Math.min(assigned - closed, orientedQuantity - reserved))
      exposureReserved.set(key, reserved + available)
      for (const child of group.children) {
        if (child.status === 'cancelled') continue
        const filled = child.filledQuantity ?? 0
        child.quantity = filled + available
        child.remainingQuantity = available
        if (available > 0) child.status = filled > 0 ? 'partially-filled' : 'working'
        else if (filled > 0) child.status = child.status === 'filled' ? 'filled' : 'cancelled'
        else if (assigned > 0 || group.parent.status === 'cancelled') child.status = 'cancelled'
        else child.status = 'inactive'
        history(child)
      }
    }
  }
  const add = (
    draft: TradingOrderDraft,
    closeOnly = draft.optionLegs?.[0]?.positionEffect === 'close',
  ): TradingOrder => {
    const order: TradingOrder = {
      ...structuredClone(draft),
      id: `mock-order-${++sequence}`,
      accountId,
      status: 'working',
      filledQuantity: 0,
      remainingQuantity: draft.quantity,
      createdAt: now(),
      updatedAt: now(),
      metadata: { provider: MOCK_PROVIDER, synthetic: true },
      pipSize: SYNTHETIC_PIP_SIZE,
    }
    state.orders.push(order)
    working.set(order.id, {
      draft: structuredClone(draft),
      triggered: false,
      closeOnly,
    })
    history(order)
    return order
  }
  const attach = (parent: TradingOrder, draft: TradingOrderDraft) => {
    for (const level of draft.exits?.levels ?? []) {
      const children: TradingOrder[] = []
      const base: TradingOrderDraft = {
        symbol: draft.symbol,
        side: draft.side === 'buy' ? 'sell' : 'buy',
        type: 'limit',
        quantity: level.quantity,
        parentId: parent.id,
        parentType: 'order',
        bracketGroupId: parent.id,
        exitLevelId: level.id,
        duration: draft.duration ?? { type: 'gtc' },
        customFields: { synthetic: true },
      }
      if (level.takeProfit)
        children.push(add({ ...base, type: 'limit', price: level.takeProfit.price }))
      if (level.stopLoss?.kind === 'fixed')
        children.push(
          add({
            ...base,
            type: level.stopLoss.limitPrice === undefined ? 'stop' : 'stop-limit',
            stopPrice: level.stopLoss.triggerPrice,
            ...(level.stopLoss.limitPrice === undefined
              ? {}
              : { price: level.stopLoss.limitPrice }),
          }),
        )
      if (level.stopLoss?.kind === 'trailing')
        children.push(
          add({
            ...base,
            type: 'trailing-stop',
            trailingStopPips: level.stopLoss.trailingPips,
          }),
        )
      for (const child of children) {
        child.status = 'inactive'
        child.remainingQuantity = 0
        history(child)
      }
      protections.set(`${parent.id}:${level.id}`, {
        parent,
        quantity: level.quantity,
        children,
      })
    }
  }
  const executablePrice = (order: TradingOrder, quote: Quote, initial?: TradingOrderContext) => {
    const entry = working.get(order.id)
    if (!entry) return undefined
    const sidePrice = order.side === 'buy' ? quote.ask : quote.bid
    let price = sidePrice ?? quote.last
    if (initial && order.type === 'market')
      price = entry.draft.optionLegs?.[0]
        ? (entry.draft.optionLegs[0].price ?? price)
        : ((order.side === 'buy' ? initial.ask : initial.bid) ?? initial.lastPrice ?? price)
    if (!positive(price)) return undefined
    const last = quote.last ?? price
    if (order.type === 'trailing-stop') {
      entry.anchor =
        entry.anchor === undefined
          ? last
          : order.side === 'sell'
            ? Math.max(entry.anchor, last)
            : Math.min(entry.anchor, last)
      const distance = positive(order.trailingStopPips)
        ? Number(order.trailingStopPips) * SYNTHETIC_PIP_SIZE
        : (entry.anchor * Number(order.trailPercent)) / 100
      order.stopPrice = entry.anchor + (order.side === 'sell' ? -distance : distance)
    }
    if (['stop', 'stop-limit', 'trailing-stop'].includes(order.type)) {
      if (!entry.triggered)
        entry.triggered =
          order.side === 'buy' ? last >= Number(order.stopPrice) : last <= Number(order.stopPrice)
      if (!entry.triggered) {
        history(order)
        return undefined
      }
    }
    if (order.type === 'limit' || order.type === 'stop-limit') {
      const limit = order.price ?? entry.draft.optionLegs?.[0]?.price
      if (order.side === 'buy' ? price > Number(limit) : price < Number(limit)) return undefined
    }
    return price
  }
  const fill = (order: TradingOrder, quantity: number, price: number) => {
    requireSupportedOrder(order)
    const draft = working.get(order.id)?.draft
    if (!draft) throw new Error('Synthetic order draft is missing.')
    const contract = draft.optionLegs?.[0]?.contract
    const symbol = orderSymbol(draft)
    const multiplier = contract?.multiplier ?? 1
    const index = state.positions.findIndex(
      (position) =>
        positionKey(position) ===
        (contract ? optionIdentity(contract) : instrumentIdentity(symbol)),
    )
    const existing = state.positions[index]
    const before = existing
      ? existing.side === 'long'
        ? existing.quantity
        : -existing.quantity
      : 0
    const delta = order.side === 'buy' ? quantity : -quantity
    const after = before + delta
    const positionId = existing?.id ?? `mock-position-${++sequence}`
    const closes = before !== 0 && Math.sign(before) !== Math.sign(delta)
    const realizedPnl = closes
      ? (before > 0
          ? price - Number(existing?.averagePrice)
          : Number(existing?.averagePrice) - price) *
        Math.min(Math.abs(before), quantity) *
        multiplier
      : 0
    if (after === 0) {
      if (index >= 0) state.positions.splice(index, 1)
    } else {
      const averagePrice = !closes
        ? (Math.abs(before) * Number(existing?.averagePrice ?? 0) + quantity * price) /
          Math.abs(after)
        : Math.sign(before) === Math.sign(after)
          ? Number(existing?.averagePrice)
          : price
      const position: TradingPosition = {
        id: positionId,
        accountId,
        symbol,
        ...(contract ? { optionContract: structuredClone(contract) } : {}),
        side: after > 0 ? 'long' : 'short',
        quantity: Math.abs(after),
        averagePrice,
        marketPrice: price,
        priceStep: 0.01,
        pipSize: SYNTHETIC_PIP_SIZE,
        actionable: true,
        customFields: {
          marketValue: Math.abs(after) * price * multiplier,
          unrealizedPnl: 0,
          provider: MOCK_PROVIDER,
          synthetic: true,
        },
      }
      if (index < 0) state.positions.push(position)
      else state.positions[index] = position
    }
    state.executions.push({
      id: `mock-execution-${++sequence}`,
      accountId,
      orderId: order.id,
      positionId,
      symbol,
      ...(contract ? { optionContract: structuredClone(contract) } : {}),
      side: order.side,
      quantity,
      price,
      time: now(),
      commission: 1,
      currency: 'USD',
      metadata: { provider: MOCK_PROVIDER, synthetic: true, realizedPnl },
    })
    const account = state.accounts[0]
    if (!account) throw new Error('Synthetic account missing.')
    account.balance = {
      ...account.balance,
      cash: money(Number(account.balance?.cash ?? 100000) - delta * price * multiplier - 1),
    }
    const priorFilled = order.filledQuantity ?? 0
    order.averagePrice =
      (priorFilled * Number(order.averagePrice ?? 0) + quantity * price) / (priorFilled + quantity)
    order.filledQuantity = priorFilled + quantity
    order.remainingQuantity = order.quantity - order.filledQuantity
    order.status = order.remainingQuantity > 0 ? 'partially-filled' : 'filled'
    order.updatedAt = now()
    history(order)
    if (order.oca) {
      for (const sibling of state.orders) {
        if (
          sibling.id === order.id ||
          !active(sibling) ||
          sibling.accountId !== order.accountId ||
          sibling.oca?.groupId !== order.oca.groupId
        )
          continue
        if (order.oca.behavior === 'cancel-with-block') cancel(sibling)
        else {
          sibling.quantity = Math.max(sibling.filledQuantity ?? 0, sibling.quantity - quantity)
          sibling.remainingQuantity = sibling.quantity - (sibling.filledQuantity ?? 0)
          if (sibling.remainingQuantity === 0) cancel(sibling)
          else history(sibling)
        }
      }
    }
    if (order.parentId) {
      const parent = state.orders.find((candidate) => candidate.id === order.parentId)
      if (parent && active(parent)) cancel(parent)
    }
    refreshProtection()
    const reversal = reversals.get(order.id)
    if (reversal && order.status === 'filled') {
      reversals.delete(order.id)
      const identity = draft.optionLegs?.[0]
        ? optionIdentity(draft.optionLegs[0].contract)
        : instrumentIdentity(draft.symbol)
      if (state.positions.some((position) => positionKey(position) === identity)) {
        if (state.messages === undefined) state.messages = []
        state.messages.push({
          id: `mock-message-${++sequence}`,
          type: 'warning',
          text: 'Synthetic reversal entry was withheld because owned exposure changed during its close.',
          time: now(),
        })
      } else add(reversal.draft)
    }
  }
  const process = (
    symbol?: SdkSymbolInfo,
    quantity?: number,
    initialOrder?: TradingOrder,
    context?: TradingOrderContext,
  ) => {
    let budget = Math.min(maxFillQuantity, quantity ?? Number.POSITIVE_INFINITY)
    validateWorkingReadback(symbol)
    refreshProtection()
    for (const order of state.orders) {
      if (!active(order)) continue
      const entry = working.get(order.id)
      if (
        !entry ||
        (symbol && instrumentIdentity(orderSymbol(entry.draft)) !== instrumentIdentity(symbol))
      )
        continue
      const price = executablePrice(
        order,
        market.quote(orderSymbol(entry.draft)),
        order === initialOrder ? context : undefined,
      )
      if (price === undefined || budget <= 0) continue
      let ownedQuantity = Number.POSITIVE_INFINITY
      if (entry.closeOnly) {
        const owned = state.positions.find(
          (position) =>
            positionKey(position) ===
            (entry.draft.optionLegs?.[0]
              ? optionIdentity(entry.draft.optionLegs[0].contract)
              : instrumentIdentity(entry.draft.symbol)),
        )
        ownedQuantity =
          owned && (order.side === 'sell' ? owned.side === 'long' : owned.side === 'short')
            ? owned.quantity
            : 0
        if (ownedQuantity === 0) {
          cancel(order)
          continue
        }
      }
      const fillQuantity = Math.min(order.remainingQuantity ?? 0, budget, ownedQuantity)
      if (fillQuantity > 0) {
        fill(order, fillQuantity, price)
        budget -= fillQuantity
      }
    }
  }
  market.subscribe((symbol, quantity) => {
    process(symbol, quantity)
    const quote = market.quote(symbol)
    for (const position of state.positions) {
      if (
        instrumentIdentity(position.symbol) !== instrumentIdentity(symbol) ||
        !positive(quote.last)
      )
        continue
      position.marketPrice = quote.last
      position.customFields = {
        ...position.customFields,
        marketValue:
          position.quantity * Number(quote.last) * (position.optionContract?.multiplier ?? 1),
        unrealizedPnl:
          (Number(quote.last) - Number(position.averagePrice)) *
          (position.side === 'long' ? 1 : -1) *
          position.quantity *
          (position.optionContract?.multiplier ?? 1),
      }
    }
    publish()
  })
  const place = (draft: TradingOrderDraft, context: TradingOrderContext, closeOnly?: boolean) => {
    validate(draft, context)
    const order = add(draft, closeOnly)
    attach(order, draft)
    process(orderSymbol(draft), undefined, order, context)
    publish()
    return {
      accepted: true,
      status: order.status === 'filled' ? ('accepted' as const) : ('submitted' as const),
      order: structuredClone(order),
      message: 'Accepted by the synthetic local exchange.',
    }
  }
  const closeDraft = (position: TradingPosition, quantity: number): TradingOrderDraft => {
    const side = position.side === 'long' ? 'sell' : 'buy'
    return {
      accountId,
      symbol: position.optionContract?.underlyingSymbolInfo ?? position.symbol,
      side,
      type: 'market',
      quantity,
      ...(position.optionContract
        ? {
            optionLegs: [
              {
                contract: position.optionContract,
                side,
                positionEffect: 'close',
                quantity,
                ratio: 1,
              },
            ],
          }
        : {}),
    }
  }
  const exactPositionContext = (position: TradingPosition, context: TradingOrderContext) => {
    if (context.accountId !== undefined && context.accountId !== accountId)
      throw new Error('Unknown synthetic account.')
    if (!position.optionContract) {
      if (instrumentIdentity(position.symbol) !== instrumentIdentity(context.symbol))
        throw new Error('Exact synthetic position context is required.')
      return context
    }
    validateOption(position.optionContract, true)
    const quote = market.quote(position.symbol)
    if (quote.status !== 'ok' || !positive(quote.bid) || !positive(quote.ask))
      throw new Error('Exact synthetic option quote is unavailable.')
    return {
      symbol: position.optionContract.underlyingSymbolInfo,
      accountId,
      ...(quote.last === undefined ? {} : { lastPrice: quote.last }),
      bid: quote.bid,
      ask: quote.ask,
    }
  }
  return {
    validate,
    place,
    previewModify(orderId: string, patch: TradingOrderPatch, context: TradingOrderContext) {
      const order = state.orders.find((candidate) => candidate.id === orderId)
      const original = working.get(orderId)
      if (!order || !active(order) || !original)
        throw new Error('Working synthetic order not found.')
      requireSupportedOrder(order)
      const { exits, oca, ...fields } = patch
      const next: TradingOrderDraft = { ...original.draft, ...fields }
      if (
        patch.quantity !== undefined &&
        (patch.quantity < (order.filledQuantity ?? 0) ||
          (order.parentId && patch.quantity > order.quantity))
      )
        throw new Error('Synthetic quantity patch exceeds owned exposure.')
      if (next.optionLegs && patch.quantity !== undefined)
        next.optionLegs = next.optionLegs.map((leg) => ({
          ...leg,
          quantity: patch.quantity ?? leg.quantity,
        }))
      if (exits === null) delete next.exits
      else if (exits !== undefined) next.exits = exits
      if (oca === null) delete next.oca
      else if (oca !== undefined) next.oca = oca
      validate(next, context)
      if (
        exits !== undefined &&
        [...protections.values()].some(
          (group) =>
            group.parent.id === orderId &&
            group.children.some((child) => (child.filledQuantity ?? 0) > 0),
        )
      )
        throw new Error('Synthetic exits cannot be replaced after protective fills.')
    },
    modify(orderId: string, patch: TradingOrderPatch, context: TradingOrderContext) {
      const order = state.orders.find((candidate) => candidate.id === orderId)
      const original = working.get(orderId)
      if (!order || !active(order) || !original)
        throw new Error('Working synthetic order not found.')
      requireSupportedOrder(order)
      if (
        patch.quantity !== undefined &&
        (!positiveInteger(patch.quantity) || patch.quantity < (order.filledQuantity ?? 0))
      )
        throw new Error('Positive quantity no smaller than filled quantity is required.')
      const { exits, oca, ...fields } = patch
      const next: TradingOrderDraft = { ...original.draft, ...fields }
      if (patch.quantity !== undefined && next.optionLegs)
        next.optionLegs = next.optionLegs.map((leg) => ({
          ...leg,
          quantity: patch.quantity ?? leg.quantity,
        }))
      if (exits === null) delete next.exits
      else if (exits !== undefined) next.exits = exits
      if (oca === null) delete next.oca
      else if (oca !== undefined) next.oca = oca
      validate(next, context)
      if (
        patch.exits !== undefined &&
        [...protections.values()].some(
          (group) =>
            group.parent.id === orderId &&
            group.children.some((child) => (child.filledQuantity ?? 0) > 0),
        )
      )
        throw new Error('Synthetic exits cannot be replaced after protective fills.')
      if (order.parentId && patch.quantity !== undefined && patch.quantity > order.quantity)
        throw new Error('Synthetic protection quantity cannot exceed its owned exposure.')
      if (patch.exits !== undefined) {
        for (const [key, group] of protections)
          if (group.parent.id === orderId) {
            group.children.forEach(cancel)
            protections.delete(key)
          }
        attach(order, next)
      }
      Object.assign(order, fields)
      if (next.optionLegs) order.optionLegs = structuredClone(next.optionLegs)
      if (oca !== null && oca !== undefined) order.oca = oca
      if (patch.oca === null) delete order.oca
      order.remainingQuantity = order.quantity - (order.filledQuantity ?? 0)
      if (order.parentId && patch.quantity !== undefined) {
        const group = [...protections.values()].find((candidate) =>
          candidate.children.includes(order),
        )
        if (group)
          group.quantity =
            patch.quantity +
            group.children
              .filter((child) => child !== order)
              .reduce((sum, child) => sum + (child.filledQuantity ?? 0), 0)
      }
      original.draft = next
      order.updatedAt = now()
      history(order)
      process(orderSymbol(next))
      publish()
      return structuredClone(order)
    },
    modifyPosition(positionId: string, patch: TradingPositionPatch, context: TradingOrderContext) {
      const position = state.positions.find((candidate) => candidate.id === positionId)
      if (!position) throw new Error('Synthetic position not found.')
      if (position.optionContract)
        throw new Error('Synthetic option position protection is unavailable.')
      const exact = exactPositionContext(position, context)
      const existing = [...protections.values()]
        .filter(
          (group) =>
            instrumentIdentity(group.parent.symbol) === instrumentIdentity(position.symbol),
        )
        .flatMap((group) => group.children.filter(active))
      const previous = (types: string[]) =>
        existing
          .filter((order) => types.includes(order.type))
          .map((order) => {
            const draft = working.get(order.id)?.draft
            return draft
              ? {
                  ...draft,
                  quantity: order.remainingQuantity ?? order.quantity,
                }
              : undefined
          })
          .filter((draft): draft is TradingOrderDraft => draft !== undefined)
      const targets =
        patch.takeProfits ??
        (patch.takeProfit === null
          ? []
          : patch.takeProfit
            ? [patch.takeProfit]
            : previous(['limit']))
      let stops =
        patch.stopLosses ??
        (patch.stopLoss === null
          ? []
          : patch.stopLoss
            ? [patch.stopLoss]
            : previous(['stop', 'stop-limit', 'trailing-stop']))
      if (patch.trailingStopPips !== undefined)
        stops = [
          {
            symbol: position.symbol,
            side: position.side === 'long' ? 'sell' : 'buy',
            type: 'trailing-stop',
            quantity: position.quantity,
            trailingStopPips: patch.trailingStopPips,
          },
        ]
      if (patch.guaranteedStop) throw new Error('Guaranteed synthetic protection is unavailable.')
      for (const draft of [...targets, ...stops]) {
        if (
          instrumentIdentity(draft.symbol) !== instrumentIdentity(position.symbol) ||
          draft.side !== (position.side === 'long' ? 'sell' : 'buy')
        )
          throw new Error('Synthetic protection must match exact position direction and identity.')
        validate(draft, exact)
      }
      const levels: NonNullable<TradingOrderDraft['exits']>['levels'] = []
      for (let index = 0; index < Math.max(targets.length, stops.length); index += 1) {
        const target = targets[index]
        const stop = stops[index]
        if (target && target.type !== 'limit')
          throw new Error('Synthetic position targets require limit orders.')
        if (stop && !['stop', 'stop-limit', 'trailing-stop'].includes(stop.type))
          throw new Error('Synthetic position stops require stop orders.')
        if (target && stop && target.quantity !== stop.quantity)
          throw new Error('Paired synthetic protection quantities must match.')
        const quantity = target?.quantity ?? stop?.quantity ?? 0
        const stopLoss =
          stop?.type === 'trailing-stop'
            ? {
                kind: 'trailing' as const,
                trailingPips: Number(stop.trailingStopPips),
              }
            : stop
              ? {
                  kind: 'fixed' as const,
                  triggerPrice: Number(stop.stopPrice),
                  ...(stop.type === 'stop-limit' ? { limitPrice: Number(stop.price) } : {}),
                }
              : undefined
        levels.push({
          id: `position-${index}`,
          quantity,
          ...(target ? { takeProfit: { price: Number(target.price) } } : {}),
          ...(stopLoss ? { stopLoss } : {}),
        })
      }
      const entry: TradingOrderDraft = {
        symbol: position.symbol,
        side: position.side === 'long' ? 'buy' : 'sell',
        type: 'market',
        quantity: position.quantity,
        ...(levels.length ? { exits: { levels } } : {}),
      }
      validate(entry, exact)
      for (const [key, group] of protections)
        if (instrumentIdentity(group.parent.symbol) === instrumentIdentity(position.symbol)) {
          group.children.forEach(cancel)
          protections.delete(key)
        }
      const parent: TradingOrder = {
        ...entry,
        id: positionId,
        accountId,
        status: 'filled',
        filledQuantity: position.quantity,
        remainingQuantity: 0,
      }
      attach(parent, entry)
      for (const group of protections.values())
        if (group.parent === parent) {
          group.positionSide = position.side
          for (const child of group.children) child.parentType = 'position'
        }
      refreshProtection()
      process(position.symbol)
      publish()
      return structuredClone(
        state.positions.find((candidate) => candidate.id === positionId) ?? {
          ...position,
          side: 'flat' as const,
          quantity: 0,
        },
      )
    },
    cancel(orderId: string) {
      const order = state.orders.find((candidate) => candidate.id === orderId)
      if (!order || (!active(order) && order.status !== 'inactive'))
        throw new Error('Working synthetic order not found.')
      requireSupportedOrder(order)
      cancel(order)
      refreshProtection()
      publish()
    },
    close(positionId: string, context: TradingOrderContext, quantity?: number) {
      const position = state.positions.find((candidate) => candidate.id === positionId)
      if (!position) throw new Error('Synthetic position not found.')
      const requested = quantity ?? position.quantity
      if (!positiveInteger(requested) || requested > position.quantity)
        throw new Error('Close quantity must be positive and within owned exposure.')
      const exact = exactPositionContext(position, context)
      validateWorkingReadback(position.symbol)
      for (const group of protections.values())
        if (
          instrumentIdentity(group.parent.symbol) === instrumentIdentity(position.symbol) &&
          active(group.parent)
        )
          cancel(group.parent)
      place(closeDraft(position, requested), exact, true)
    },
    reverse(positionId: string, context: TradingOrderContext) {
      const position = state.positions.find((candidate) => candidate.id === positionId)
      if (!position) throw new Error('Synthetic position not found.')
      if ([...reversals.values()].some((reversal) => reversal.positionId === positionId))
        throw new Error('An exact synthetic reversal is already pending.')
      const exact = exactPositionContext(position, context)
      validateWorkingReadback(position.symbol)
      if (
        state.orders.some(
          (order) =>
            active(order) &&
            !order.parentId &&
            ![...protections.values()].some((group) => group.parent === order) &&
            instrumentIdentity(orderSymbol(working.get(order.id)?.draft ?? order)) ===
              instrumentIdentity(position.symbol),
        )
      )
        throw new Error(
          'Synthetic reversal requires other exact instrument orders to settle first.',
        )
      const draft = closeDraft(position, position.quantity)
      const opening: TradingOrderDraft = {
        ...draft,
        ...(draft.optionLegs
          ? {
              optionLegs: draft.optionLegs.map((leg) => ({
                ...leg,
                positionEffect: 'open' as const,
              })),
            }
          : {}),
      }
      validate(draft, exact)
      validate(opening, exact)
      for (const group of protections.values())
        if (instrumentIdentity(group.parent.symbol) === instrumentIdentity(position.symbol)) {
          group.children.forEach(cancel)
          if (active(group.parent)) cancel(group.parent)
        }
      const closing = add(draft, true)
      reversals.set(closing.id, { positionId, draft: opening, context: exact })
      process(orderSymbol(draft), undefined, closing, exact)
      publish()
    },
  }
}

function requireSupportedOrder(order: TradingOrder): asserts order is TradingOrder & {
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop' | 'stop-limit' | 'trailing-stop'
} {
  if (order.side !== 'buy' && order.side !== 'sell')
    throw new Error('Synthetic order side must be buy or sell.')
  if (
    order.type !== 'market' &&
    order.type !== 'limit' &&
    order.type !== 'stop' &&
    order.type !== 'stop-limit' &&
    order.type !== 'trailing-stop'
  )
    throw new Error('Unsupported synthetic order type.')
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
function positiveInteger(value: number) {
  return positive(value) && Number.isInteger(value)
}
function money(value: number) {
  return Math.round(value * 100) / 100
}
function instrumentIdentity(symbol: SdkSymbolInfo) {
  return `${symbol.provider ?? ''}:${symbol.canonicalSymbol ?? symbol.brokerSymbol ?? symbol.ticker}`
}
function optionIdentity(contract: TradingOptionContract) {
  return contract.brokerContractId !== undefined
    ? `option:${String(contract.brokerContractId)}`
    : `option:${contract.underlying}:${contract.expiration}:${contract.right}:${contract.strike}:${contract.multiplier}:${contract.currency ?? ''}`
}
function positionKey(position: TradingPosition) {
  return position.optionContract
    ? optionIdentity(position.optionContract)
    : instrumentIdentity(position.symbol)
}
function sameOption(a: TradingOptionContract, b: TradingOptionContract) {
  return (
    a.underlying === b.underlying &&
    a.expiration === b.expiration &&
    a.strike === b.strike &&
    a.right === b.right &&
    a.multiplier === b.multiplier &&
    a.currency === b.currency &&
    instrumentIdentity(a.underlyingSymbolInfo) === instrumentIdentity(b.underlyingSymbolInfo)
  )
}
export function exactOptionSymbol(contract: TradingOptionContract): SdkSymbolInfo {
  const ticker =
    contract.symbol ??
    `${contract.underlying}-${contract.expiration}-${contract.right}-${contract.strike}`
  const id = String(contract.brokerContractId ?? ticker)
  return {
    ticker,
    canonicalSymbol: `mock-option:${id}`,
    brokerSymbol: id,
    exchange: contract.route ?? contract.exchange ?? 'SMART',
    listedExchange: contract.exchange ?? 'SMART',
    currency: contract.currency ?? 'USD',
    type: 'option',
    provider: MOCK_PROVIDER,
  }
}
