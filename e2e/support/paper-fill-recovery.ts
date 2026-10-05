import type {
  BrokerState,
  BrokerSymbol,
  Execution,
  Order,
  OrderDraft,
} from '@ibkr-terminal/contracts'
import type { APIRequestContext } from '@playwright/test'
import { assetCloseDraft, optionCloseDraft, remainingOwnedFill } from './paper-cleanup.js'
import { browserHeaders, expectJsonOk } from './session.js'

export const PAPER_OWNER_FIELD = 'paperE2EOwner'

export function uniqueOrderRecords(state: BrokerState): Order[] {
  const records = new Map<string, Order>()
  for (const order of [...state.orders, ...(state.ordersHistory ?? [])]) {
    const previous = records.get(order.id)
    if (
      previous &&
      (previous.filledQuantity !== order.filledQuantity ||
        previous.status !== order.status ||
        previous.accountId !== order.accountId ||
        previous.side !== order.side ||
        previous.parentId !== order.parentId ||
        previous.bracketGroupId !== order.bracketGroupId ||
        previous.clientId !== order.clientId ||
        previous.brokerOrderId !== order.brokerOrderId ||
        previous.permId !== order.permId ||
        previous.brokerOrderRef !== order.brokerOrderRef ||
        JSON.stringify(previous.symbol) !== JSON.stringify(order.symbol) ||
        previous.quantity !== order.quantity ||
        JSON.stringify(previous.optionLegs) !== JSON.stringify(order.optionLegs) ||
        JSON.stringify(previous.strategyLegs) !== JSON.stringify(order.strategyLegs) ||
        previous.customFields?.[PAPER_OWNER_FIELD] !== order.customFields?.[PAPER_OWNER_FIELD] ||
        previous.customFields?.ibkrMissingOpenOrder !== order.customFields?.ibkrMissingOpenOrder ||
        previous.customFields?.ibkrReadbackUnsupported !==
          order.customFields?.ibkrReadbackUnsupported ||
        previous.customFields?.ibkrOwnershipContradiction !==
          order.customFields?.ibkrOwnershipContradiction)
    )
      throw new Error('Conflicting current/history records for an owned-fill snapshot')
    records.set(order.id, order)
  }
  return [...records.values()]
}

/** Parent units never size a combo close. Each native leg needs complete actual execution facts. */
function nativeLegFillRecords(
  order: Order,
  executions: readonly Execution[],
  replayedOrderIds: ReadonlySet<string>,
  coveredFromDispatchOrderIds: ReadonlySet<string>,
): Order[] {
  const legs = order.strategyLegs?.length ? order.strategyLegs : order.optionLegs
  if (
    !legs ||
    legs.length < 2 ||
    !replayedOrderIds.has(order.id) ||
    !order.brokerOrderRef ||
    !Number.isSafeInteger(order.permId) ||
    !(Number(order.permId) > 0) ||
    !Number.isInteger(order.clientId) ||
    !order.accountId ||
    order.customFields?.ibkrOwnershipContradiction === true
  )
    throw new Error('Fallback cleanup needs authoritative per-leg fills for a multi-leg strategy')
  const related = executions.filter((execution) => execution.orderId === order.id)
  const exact = new Map<string, Execution>()
  const correction = (id: string) => {
    const match = /^(.*)\.(\d+)$/u.exec(id)
    return { key: match?.[1] ?? id, revision: match ? Number(match[2]) : 0 }
  }
  for (const execution of related) {
    if (
      execution.accountId !== order.accountId ||
      execution.permId !== order.permId ||
      execution.clientId !== order.clientId ||
      execution.brokerOrderRef !== order.brokerOrderRef ||
      !execution.id ||
      !Number.isFinite(execution.quantity) ||
      !(execution.quantity > 0) ||
      !Number.isFinite(execution.cumulativeQuantity) ||
      Number(execution.cumulativeQuantity) < execution.quantity ||
      !['buy', 'sell'].includes(execution.side)
    )
      throw new Error(
        'Owned leg execution lacks exact account/native binding or cumulative quantity',
      )
    // BAG executions describe strategy units, not any individual native contract exposure.
    if (execution.symbol.contractIdentity?.securityType === 'BAG') continue
    const key = correction(execution.id).key,
      previous = exact.get(key)
    if (previous) {
      if (
        previous.symbol.contractIdentity?.conId !== execution.symbol.contractIdentity?.conId ||
        previous.side !== execution.side ||
        previous.symbol.currency !== execution.symbol.currency ||
        (previous.id === execution.id &&
          (previous.quantity !== execution.quantity ||
            previous.cumulativeQuantity !== execution.cumulativeQuantity))
      )
        throw new Error(
          'Owned native leg execution corrections have inconsistent identities or units',
        )
      if (correction(previous.id).revision > correction(execution.id).revision) continue
    }
    exact.set(key, execution)
  }
  const nativeIds = new Set<number>()
  const result: Order[] = []
  for (const leg of legs) {
    const option = 'contract' in leg ? leg.contract : undefined
    const conId = Number(
      option?.brokerContractId ??
        ('symbolInfo' in leg ? leg.symbolInfo.contractIdentity?.conId : undefined),
    )
    const ratio = leg.ratio ?? 1
    if (
      !Number.isSafeInteger(conId) ||
      conId <= 0 ||
      nativeIds.has(conId) ||
      !Number.isSafeInteger(ratio) ||
      ratio <= 0 ||
      !Number.isFinite(leg.quantity) ||
      leg.quantity !== order.quantity * ratio ||
      !['buy', 'sell'].includes(leg.side)
    )
      throw new Error('Owned combo intent has no exact distinct leg identity/ratio/quantity')
    nativeIds.add(conId)
    const fills = [...exact.values()].filter(
      (execution) => execution.symbol.contractIdentity?.conId === conId,
    )
    const reference = fills[0]
    if (!reference) {
      if (
        !coveredFromDispatchOrderIds.has(order.id) ||
        order.status === 'filled' ||
        (order.filledQuantity !== undefined && order.filledQuantity > 0) ||
        related.some(
          (execution) =>
            execution.symbol.contractIdentity?.securityType === 'BAG' && execution.quantity > 0,
        )
      )
        throw new Error('A native strategy leg has no authoritative execution total')
      // A persisted uninterrupted native stream plus a terminal replay checkpoint proves
      // this exact leg has zero executions; parent cumulative units play no part.
      continue
    }
    const total = fills.reduce((sum, execution) => sum + execution.quantity, 0)
    const cumulative = Math.max(...fills.map((execution) => execution.cumulativeQuantity!))
    const expectedType = option
      ? option.underlyingSymbolInfo.assetClass === 'futures'
        ? 'FOP'
        : 'OPT'
      : 'STK'
    const expectedCurrency =
      option?.currency ?? ('symbolInfo' in leg ? leg.symbolInfo.currency : undefined)
    const normalized = (value: string | undefined) => value?.replace(/[-\s]/gu, '')
    if (
      !expectedCurrency ||
      reference.symbol.currency !== expectedCurrency ||
      reference.symbol.contractIdentity?.securityType !== expectedType ||
      fills.some(
        (execution) =>
          execution.side !== leg.side ||
          exactContractKey(execution.symbol) !== exactContractKey(reference.symbol) ||
          JSON.stringify(execution.symbol.contractIdentity) !==
            JSON.stringify(reference.symbol.contractIdentity),
      ) ||
      cumulative !== total ||
      total > leg.quantity ||
      (order.status === 'filled' && total !== leg.quantity) ||
      (option &&
        (normalized(reference.symbol.contractIdentity.expiry) !== normalized(option.expiration) ||
          reference.symbol.contractIdentity.strike !== option.strike ||
          reference.symbol.contractIdentity.right !== (option.right === 'call' ? 'C' : 'P') ||
          reference.symbol.contractIdentity.multiplier !== option.multiplier))
    )
      throw new Error('Owned native per-leg executions do not establish complete exact fill terms')
    result.push({
      ...order,
      id: `${order.id}@leg:${conId}`,
      symbol: reference.symbol,
      side: leg.side,
      quantity: total,
      filledQuantity: total,
      remainingQuantity: 0,
      status: 'filled',
      strategyLegs: undefined,
      optionLegs: option ? [{ ...leg, contract: option, quantity: total, ratio: 1 }] : undefined,
    })
  }
  if (
    [...exact.values()].some(
      (execution) => !nativeIds.has(execution.symbol.contractIdentity!.conId!),
    )
  )
    throw new Error(
      'Owned execution references a contract outside the immutable native combo intent',
    )
  return result
}

function exactContractKey(symbol: BrokerSymbol): string {
  const identity = symbol.contractIdentity
  if (
    !identity?.securityType ||
    !Number.isInteger(identity.conId) ||
    !(Number(identity.conId) > 0) ||
    !symbol.currency ||
    !symbol.assetClass
  )
    throw new Error('Owned fill has no authoritative native contract identity')
  const classes: Record<string, string> = {
    STK: 'stock',
    FUT: 'futures',
    CASH: 'forex',
    CRYPTO: 'crypto',
    BOND: 'bond',
    WAR: 'warrant',
    CMDTY: 'commodity',
    CFD: 'cfd',
    FUND: 'fund',
    IND: 'index',
    FOP: 'futures-option',
    OPT: symbol.exchange === 'FORECASTX' ? 'event-contract' : 'option',
  }
  if (classes[identity.securityType] !== symbol.assetClass)
    throw new Error('Owned native security type contradicts its asset class')
  return JSON.stringify([identity.securityType, identity.conId, symbol.assetClass, symbol.currency])
}

function validateFill(order: Order, unknownStrategyUnits = false): void {
  if (
    !order.accountId ||
    !['buy', 'sell'].includes(order.side) ||
    !Number.isFinite(order.quantity) ||
    !(order.quantity > 0) ||
    ((!unknownStrategyUnits || order.filledQuantity !== undefined) &&
      (!Number.isFinite(order.filledQuantity) ||
        Number(order.filledQuantity) < 0 ||
        Number(order.filledQuantity) > order.quantity))
  )
    throw new Error('Owned fill quantity or account identity is unavailable or inconsistent')
  if (
    order.status === 'filled' &&
    order.filledQuantity !== undefined &&
    Math.abs(order.filledQuantity! - order.quantity) >
      Number.EPSILON * Math.max(order.quantity, order.filledQuantity!) * 4
  )
    throw new Error('Filled status contradicts the known cumulative fill quantity')
  if (order.customFields?.ibkrReadbackUnsupported === true)
    throw new Error('Owned native readback cannot establish safe fill terms')
  if (order.customFields?.ibkrMissingOpenOrder === true)
    throw new Error('Owned order absence has not been confirmed by the broker')
  if (order.customFields?.ibkrOwnershipContradiction === true)
    throw new Error('Owned durable/native facts conflict or are unavailable; outcome is unknown')
}

/** Plans only exact owned records. Account positions never participate in ownership or sizing. */
export async function ownedRecoveryDrafts(
  request: APIRequestContext,
  records: readonly Order[],
  executions: readonly Execution[] = [],
  replayedOrderIds: ReadonlySet<string> = new Set(),
  coveredFromDispatchOrderIds: ReadonlySet<string> = new Set(),
): Promise<OrderDraft[]> {
  const groups = new Map<string, Order[]>()
  const identities = new Map<number, BrokerSymbol>()
  const filledRecords: Order[] = []
  for (const order of records) {
    const multi = (order.optionLegs?.length ?? 0) > 1 || (order.strategyLegs?.length ?? 0) > 1
    validateFill(order, multi)
    if (multi)
      filledRecords.push(
        ...nativeLegFillRecords(order, executions, replayedOrderIds, coveredFromDispatchOrderIds),
      )
    else filledRecords.push(order)
  }
  for (const order of filledRecords) {
    validateFill(order)
    // A zero-fill cancellation needs no contract reconstruction or market-data request.
    if (order.filledQuantity === 0) continue
    const contractKey = exactContractKey(order.symbol)
    const id = order.symbol.contractIdentity!.conId!
    const prior = identities.get(id)
    if (
      prior &&
      (prior.currency !== order.symbol.currency ||
        prior.assetClass !== order.symbol.assetClass ||
        Object.entries(prior.contractIdentity!).some(
          ([field, value]) =>
            order.symbol.contractIdentity![
              field as keyof NonNullable<BrokerSymbol['contractIdentity']>
            ] !== undefined &&
            order.symbol.contractIdentity![
              field as keyof NonNullable<BrokerSymbol['contractIdentity']>
            ] !== value,
        ))
    )
      throw new Error('Owned native contract metadata contradicts another retained record')
    identities.set(id, {
      ...prior,
      ...order.symbol,
      contractIdentity: { ...prior?.contractIdentity, ...order.symbol.contractIdentity! },
    })
    const leg = order.strategyLegs?.[0] ?? order.optionLegs?.[0]
    if (leg) {
      const contract = 'contract' in leg ? leg.contract : undefined
      if (
        !contract ||
        !['OPT', 'FOP'].includes(order.symbol.contractIdentity!.securityType) ||
        Number(contract.brokerContractId) !== id ||
        leg.side !== order.side ||
        leg.quantity !== order.quantity ||
        (leg.ratio !== undefined && leg.ratio !== 1)
      )
        throw new Error(
          'Fallback option leg does not match the exact native parent contract/side/quantity',
        )
    }
    const key = JSON.stringify([order.accountId, contractKey])
    const group = groups.get(key) ?? []
    group.push(order)
    groups.set(key, group)
  }
  const drafts: OrderDraft[] = []
  const covered = new Set<string>()
  for (const [key, group] of groups) {
    if (covered.has(key)) continue
    const reference = group[0]!
    let close = assetCloseDraft(group, reference.symbol, {
      type: reference.symbol.assetClass === 'crypto' ? 'ioc' : 'day',
    })
    if (!close) continue
    if (reference.symbol.assetClass === 'event-contract') {
      if (reference.symbol.exchange !== 'FORECASTX' || close.side !== 'sell')
        throw new Error('Fallback event cleanup requires a known long ForecastEx outcome')
      const opposite = await expectJsonOk<BrokerSymbol>(
        await request.get(
          `/api/v1/ibkr/contracts/opposing-outcome?${new URLSearchParams({
            symbol: reference.symbol.canonicalSymbol ?? reference.symbol.symbol,
            currency: reference.symbol.currency!,
          })}`,
          { headers: browserHeaders },
        ),
      )
      const oppositeKey = JSON.stringify([reference.accountId, exactContractKey(opposite)])
      const sourceIdentity = reference.symbol.contractIdentity!,
        oppositeIdentity = opposite.contractIdentity!
      const expiry = (value: string | undefined) => value?.replace(/\s+/gu, '')
      const sameEvent =
        sourceIdentity.securityType === 'OPT' &&
        oppositeIdentity.securityType === 'OPT' &&
        reference.symbol.symbol === opposite.symbol &&
        sourceIdentity.expiry !== undefined &&
        expiry(sourceIdentity.expiry) === expiry(oppositeIdentity.expiry) &&
        sourceIdentity.strike !== undefined &&
        sourceIdentity.strike === oppositeIdentity.strike &&
        ((sourceIdentity.right === 'C' && oppositeIdentity.right === 'P') ||
          (sourceIdentity.right === 'P' && oppositeIdentity.right === 'C')) &&
        ['tradingClass', 'multiplier'].every((field) => {
          const k = field as 'tradingClass' | 'multiplier'
          return sourceIdentity[k] === oppositeIdentity[k]
        })
      if (
        !sameEvent ||
        oppositeKey === key ||
        opposite.currency !== reference.symbol.currency ||
        opposite.assetClass !== 'event-contract' ||
        opposite.exchange !== 'FORECASTX'
      )
        throw new Error('Opposing outcome identity does not match the owned ForecastEx contract')
      const oppositeOrders = groups.get(oppositeKey) ?? []
      if (oppositeOrders.some((order) => order.side !== 'buy'))
        throw new Error('Unexpected short opposing-outcome fill')
      const residual = remainingOwnedFill(
        close.quantity,
        oppositeOrders,
        oppositeOrders.map((order) => order.id),
      )
      covered.add(oppositeKey)
      if (residual === 0) continue
      const quotes = await expectJsonOk<BrokerState['quotes']>(
        await request.get(
          `/api/v1/ibkr/quotes?fresh=true&${new URLSearchParams({
            symbol: opposite.canonicalSymbol ?? opposite.symbol,
            exchange: opposite.exchange,
            currency: opposite.currency!,
            assetClass: 'event-contract',
          })}`,
          { headers: browserHeaders },
        ),
      )
      const quote = quotes.find(
        (value) =>
          value.symbol.contractIdentity?.conId === opposite.contractIdentity?.conId &&
          value.symbol.currency === opposite.currency &&
          value.symbol.assetClass === opposite.assetClass &&
          value.symbol.contractIdentity?.securityType === opposite.contractIdentity?.securityType &&
          value.symbol.exchange === opposite.exchange,
      )
      if (
        !quote ||
        quote.status !== 'ok' ||
        !Number.isFinite(quote.ask) ||
        Number(quote.ask) < 0.01 ||
        Number(quote.ask) > 0.99 ||
        !Number.isFinite(Date.parse(quote.timestamp)) ||
        Date.now() - Date.parse(quote.timestamp) < 0 ||
        Date.now() - Date.parse(quote.timestamp) >= 30_000
      )
        throw new Error('Fallback ForecastEx cleanup requires a fresh exact opposing-outcome ask')
      drafts.push({
        symbol: opposite,
        accountId: reference.accountId,
        side: 'buy',
        type: 'limit',
        quantity: residual,
        limitPrice: quote.ask,
        duration: 'day',
      })
      continue
    }
    if (reference.symbol.assetClass === 'crypto') {
      const session = await expectJsonOk<{
        symbol?: {
          canonicalSymbol?: string
          brokerSymbol?: string
          type?: string
          currency?: string
        }
        metadata?: { quantityStep?: number }
      }>(
        await request.get(
          `/api/v1/ibkr/sessions?${new URLSearchParams({
            symbol: reference.symbol.canonicalSymbol ?? reference.symbol.symbol,
            exchange: reference.symbol.exchange ?? '',
            currency: reference.symbol.currency!,
            assetClass: 'crypto',
          })}`,
          { headers: browserHeaders },
        ),
      )
      const selected = session.symbol
      if (
        !selected ||
        (selected.canonicalSymbol ?? selected.brokerSymbol) !== reference.symbol.canonicalSymbol ||
        selected.type !== 'crypto' ||
        selected.currency !== reference.symbol.currency
      )
        throw new Error(
          'Crypto quantity increments do not belong to the exact owned native contract',
        )
      const step = session.metadata?.quantityStep
      if (!Number.isFinite(step) || !(Number(step) > 0))
        throw new Error('Fallback crypto cleanup requires broker quantity increments')
      const tolerance =
        Number.EPSILON *
        group.reduce((sum, order) => sum + order.filledQuantity!, 0) *
        Math.max(1, group.length) *
        4
      const rounded = assetCloseDraft(group, reference.symbol, { type: 'ioc' }, step)
      if (rounded && rounded.quantity - close.quantity > tolerance)
        throw new Error('Broker quantity rounding would exceed the exact owned residual')
      if (!rounded && close.quantity > tolerance)
        throw new Error(
          'Exact crypto fill residual is below the broker quantity step and remains unclosed',
        )
      close = rounded
      if (!close) continue
    }
    if (
      ![
        'stock',
        'futures',
        'forex',
        'crypto',
        'bond',
        'option',
        'futures-option',
        'warrant',
        'commodity',
        'cfd',
      ].includes(reference.symbol.assetClass!)
    )
      throw new Error('Fallback cleanup has no explicit close policy for this native asset class')
    const leg = reference.strategyLegs?.[0] ?? reference.optionLegs?.[0]
    if (leg && ['OPT', 'FOP'].includes(reference.symbol.contractIdentity?.securityType ?? '')) {
      const ownedSide = close.side === 'buy' ? ('sell' as const) : ('buy' as const)
      const option = optionCloseDraft(close.quantity, {
        ...reference,
        side: ownedSide,
        optionLegs: reference.optionLegs?.map((leg) => ({ ...leg, side: ownedSide })),
        strategyLegs: reference.strategyLegs?.map((leg) => ({ ...leg, side: ownedSide })),
      })!
      drafts.push({
        ...option,
        symbol: reference.symbol,
        accountId: reference.accountId,
        duration: 'day',
      })
      continue
    }
    // FOP and native options without an effect use the authoritative native conId path.
    drafts.push({
      symbol: reference.symbol,
      accountId: reference.accountId,
      side: close.side,
      type: 'market',
      quantity: close.quantity,
      duration: close.duration?.type === 'ioc' ? 'ioc' : 'day',
    })
  }
  return drafts
}
