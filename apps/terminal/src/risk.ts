import type { ExecutionEnvironment, TradeScriptBootstrapResponse } from '@ibkr-terminal/contracts'
import type {
  MarketDataFeed,
  Quote,
  RiskOrderDecisionRequest,
  RiskPolicyHostControllerApi,
  RiskPolicyUtilization,
  RiskPolicyUtilizationSource,
  SdkSymbolInfo,
  TradeScriptSdkProducts,
  TradingBrokerAdapter,
  TradingModifyOrderRiskIntent,
  TradingModifyPositionRiskIntent,
  TradingOptionContract,
  TradingOrderDraft,
  TradingOrderSide,
  TradingPlaceOrderRiskIntent,
  TradingReversePositionRiskIntent,
  TradingRiskDecisionRequestFactories,
  TradingState,
  Unsubscribe,
} from '@tradescript/pro/sdk'
import { SUPPORTED_ORDER_TYPES } from './ibkr/broker-order-rules.js'
import { MOCK_PROVIDER } from './mock/identity.js'

type AgentTradingBootstrap = TradeScriptBootstrapResponse['paperTrading']
type UnitRiskRequest = RiskOrderDecisionRequest & {
  quantity: number
  projectedPositionQuantity: number
  projectedPositionNotional: number
}

export interface ConnectionRiskAuthority {
  readonly controller: RiskPolicyHostControllerApi
  readonly requests: TradingRiskDecisionRequestFactories
  destroy(): void
}

class BrokerUtilizationSource implements RiskPolicyUtilizationSource {
  readonly #listeners = new Set<(snapshot: RiskPolicyUtilization) => void>()
  #snapshot: RiskPolicyUtilization
  #revision = 0

  constructor(state: TradingState, positions: RiskPolicyUtilization['positions']) {
    this.#snapshot = this.#project(state, positions)
  }

  getCurrentUtilization(): RiskPolicyUtilization {
    return this.#snapshot
  }

  subscribe(callback: (snapshot: RiskPolicyUtilization) => void): Unsubscribe {
    this.#listeners.add(callback)
    return () => this.#listeners.delete(callback)
  }

  update(state: TradingState, positions: RiskPolicyUtilization['positions']): void {
    this.#snapshot = this.#project(state, positions)
    for (const listener of this.#listeners) listener(this.#snapshot)
  }

  destroy(): void {
    this.#listeners.clear()
  }

  #project(
    state: TradingState,
    positions: RiskPolicyUtilization['positions'],
  ): RiskPolicyUtilization {
    const asOf = Date.now()
    const orders = new Map(
      [...state.orders, ...(state.ordersHistory ?? [])].map((order) => [
        `${order.accountId}:${order.id}`,
        order,
      ]),
    )
    const accounts = state.accounts.flatMap((account) => {
      const dailyPnl = numberField(account.customFields, 'dailyPnl')
      const accountOrders = [...orders.values()].filter((order) => order.accountId === account.id)
      if (
        dailyPnl === undefined ||
        state.ordersHistory === undefined ||
        accountOrders.some((order) => !isNonNegative(order.createdAt) || order.createdAt > asOf)
      )
        return []
      const createdAfter = asOf - 60_000
      return [
        {
          accountId: account.id,
          dailyLoss: Math.max(0, -dailyPnl),
          ordersInLastMinute: accountOrders.filter(
            (order) =>
              isNonNegative(order.createdAt) &&
              order.createdAt >= createdAfter &&
              order.createdAt <= asOf,
          ).length,
        },
      ]
    })
    return {
      revision: ++this.#revision,
      asOf,
      accounts,
      positions,
    }
  }
}

export async function createConnectionRiskAuthority(
  sdk: TradeScriptSdkProducts,
  broker: TradingBrokerAdapter,
  datafeed: MarketDataFeed,
  config: AgentTradingBootstrap,
  executionEnvironment: ExecutionEnvironment = 'paper',
): Promise<ConnectionRiskAuthority> {
  if (!config.enabled || config.limits === undefined || config.allowedAccountIds.length === 0) {
    throw new Error('Agent trading requires an enabled connection and selected accounts.')
  }
  const state = await broker.getState()
  const { maxGrossExposure, ...sdkLimits } = config.limits
  const utilization = new BrokerUtilizationSource(
    state,
    await positionUtilization(broker, state, sdkLimits.maxMarketDataAgeMs),
  )
  const controller = sdk.trading.createRiskPolicyController({
    policy: {
      autonomyMode: executionEnvironment === 'live' ? 'bounded-live-auto' : 'paper-auto',
      accounts: { mode: 'allow-list', values: config.allowedAccountIds },
      instruments: { mode: 'all' },
      sessions: { mode: 'all' },
      sides: { mode: 'all' },
      orderTypes: { mode: 'all' },
      limits: sdkLimits,
    },
    utilization,
    receiptCapacity: 1_000,
  })

  let latestState = state
  let refreshQueued = false
  let refreshPromise: Promise<void> | undefined
  let refreshFailure: unknown
  let destroyed = false
  const refresh = () => {
    if (destroyed) return
    refreshQueued = true
    if (refreshPromise) return
    refreshPromise = Promise.resolve()
      .then(async () => {
        while (refreshQueued && !destroyed) {
          refreshQueued = false
          try {
            const nextState = await broker.getState()
            const positions = await positionUtilization(
              broker,
              nextState,
              sdkLimits.maxMarketDataAgeMs,
            )
            if (destroyed) return
            latestState = nextState
            utilization.update(nextState, positions)
            refreshFailure = undefined
          } catch (error: unknown) {
            refreshFailure = error
          }
        }
      })
      .finally(() => {
        refreshPromise = undefined
        if (refreshQueued && !destroyed) refresh()
      })
  }
  const unsubscribe = broker.subscribe?.(() => refresh())
  const requireAccountFacts = (accountId: string) => {
    if (
      latestState.connectionStatus !== 'connected' ||
      !utilization
        .getCurrentUtilization()
        .accounts.some((account) => account.accountId === accountId)
    ) {
      throw new Error(
        'Current account risk facts, including broker daily PnL and order history, are unavailable.',
      )
    }
  }

  const orderRequest = async (input: {
    operation: string
    accountId: string
    symbol: SdkSymbolInfo
    instrumentId: string
    side: TradingOrderSide
    orderType: TradingPlaceOrderRiskIntent['draft']['type']
    quantity: number
    multiplier?: number
    explicitPrice?: number
    operationId?: string
    timeInForce?: TradingPlaceOrderRiskIntent['draft']['duration']
    atomicConstituent?: boolean
  }): Promise<UnitRiskRequest> => {
    while (refreshPromise) await refreshPromise
    if (refreshFailure !== undefined) {
      throw new Error('Current broker position sizing is unavailable for risk evaluation.')
    }
    requireAccountFacts(input.accountId)
    if (
      input.symbol.provider === MOCK_PROVIDER &&
      latestState.accounts.find((account) => account.id === input.accountId)?.brokerName !==
        MOCK_PROVIDER
    )
      throw new Error('Synthetic option identity is not authorized by this broker account.')
    await requireMonetaryUnits(broker, input.symbol, input.accountId)
    const multiplier =
      input.multiplier ?? (await contractMultiplier(broker, input.symbol, input.accountId))
    const quote = await requireQuote(datafeed, input.symbol)
    while (refreshPromise) await refreshPromise
    if (refreshFailure !== undefined)
      throw new Error('Current broker position sizing is unavailable for risk evaluation.')
    requireAccountFacts(input.accountId)
    const conversion = await accountCurrencyRate(
      broker,
      latestState,
      input.symbol,
      input.accountId,
      sdkLimits.maxMarketDataAgeMs,
    )
    let projectionState: TradingState
    let positions: RiskPolicyUtilization['positions']
    do {
      while (refreshPromise) await refreshPromise
      projectionState = latestState
      positions = await positionUtilization(broker, projectionState, sdkLimits.maxMarketDataAgeMs)
      while (refreshPromise) await refreshPromise
    } while (latestState !== projectionState)
    if (refreshFailure !== undefined)
      throw new Error('Current broker position sizing is unavailable for risk evaluation.')
    utilization.update(projectionState, positions)
    requireAccountFacts(input.accountId)
    // The decision is requested after its asynchronous broker and market-data facts arrive.
    const requestedAt = Date.now()
    const quotedPrice = input.side === 'buy' ? positive(quote.ask) : positive(quote.bid)
    if (quotedPrice === undefined || !isNonNegative(quote.timestamp)) {
      throw new Error(`Current IBKR price facts are unavailable for ${input.symbol.ticker}.`)
    }
    const price = Math.max(quotedPrice, positive(input.explicitPrice) ?? quotedPrice)
    const currentPosition = latestState.positions.find(
      (position) =>
        position.accountId === input.accountId &&
        riskPositionInstrumentId(position) === input.instrumentId,
    )
    const signedCurrent =
      currentPosition?.side === 'short'
        ? -currentPosition.quantity
        : currentPosition?.side === 'long'
          ? currentPosition.quantity
          : 0
    const signedOrder = input.side === 'buy' ? input.quantity : -input.quantity
    const projectedQuantity = Math.abs(signedCurrent + signedOrder)
    const projectedNotional = projectedQuantity * price * multiplier * conversion.rate
    if (maxGrossExposure !== undefined && !input.atomicConstituent) {
      const otherExposure = utilization
        .getCurrentUtilization()
        .positions.reduce(
          (sum, position) =>
            position.accountId === input.accountId && position.instrumentId !== input.instrumentId
              ? sum + position.absoluteNotional
              : sum,
          0,
        )
      if (otherExposure + projectedNotional > maxGrossExposure)
        throw new Error('Projected gross account exposure exceeds the configured risk limit.')
    }
    const midpoint =
      positive(quote.bid) !== undefined && positive(quote.ask) !== undefined
        ? (Number(quote.bid) + Number(quote.ask)) / 2
        : undefined
    const estimatedSlippageBps =
      midpoint === undefined || midpoint === 0
        ? 0
        : (Math.abs(Number(quote.ask) - Number(quote.bid)) / midpoint) * 10_000
    return {
      kind: 'order-exposure',
      decisionId: input.operationId ?? `terminal:${input.operation}:${crypto.randomUUID()}`,
      requestedAt,
      executionEnvironment,
      accountId: input.accountId,
      instrumentId: input.instrumentId,
      session: input.symbol.session ?? 'regular',
      side: input.side,
      orderType: input.orderType,
      ...(input.timeInForce === undefined ? {} : { timeInForce: input.timeInForce.type }),
      quantity: input.quantity,
      notional: input.quantity * price * multiplier * conversion.rate,
      projectedPositionQuantity: projectedQuantity,
      projectedPositionNotional: projectedNotional,
      estimatedSlippageBps,
      marketDataAsOf: Math.min(quote.timestamp, conversion.asOf ?? quote.timestamp),
    }
  }

  const requestForOrder = async (
    order: TradingOrderDraft,
    accountId: string,
    operation: 'placeOrder' | 'modifyOrder' | 'reversePosition',
    operationId?: string,
    modifiedQuantity?: number,
    modifiedPrice?: number,
  ): Promise<RiskOrderDecisionRequest> => {
    const legs = order.strategyLegs?.length
      ? order.strategyLegs
      : order.optionLegs?.map((leg) => ({ ...leg, instrument: 'option' as const }))
    if (!legs || legs.length < 2)
      return orderRequest({
        operation,
        accountId,
        orderType: order.type,
        ...orderExposureFacts(order, modifiedQuantity, modifiedPrice),
        ...(operationId === undefined ? {} : { operationId }),
        ...(order.duration === undefined ? {} : { timeInForce: order.duration }),
      })
    if (!supportsAtomicRisk(controller))
      throw new Error(
        'Multi-leg agent risk requires atomic per-leg exposure, which this SDK does not support.',
      )
    let projectionState: TradingState
    let constituents: UnitRiskRequest[]
    do {
      while (refreshPromise) await refreshPromise
      projectionState = latestState
      constituents = await Promise.all(
        legs.map((leg) =>
          orderRequest({
            operation,
            accountId,
            orderType: order.type,
            atomicConstituent: true,
            ...orderExposureFacts(
              { ...order, strategyLegs: [leg] },
              modifiedQuantity,
              modifiedPrice,
            ),
            ...(operationId === undefined ? {} : { operationId }),
            ...(order.duration === undefined ? {} : { timeInForce: order.duration }),
          }),
        ),
      )
      while (refreshPromise) await refreshPromise
    } while (latestState !== projectionState)
    const primary = constituents[0]
    if (!primary) throw new Error('Exact constituent risk facts are unavailable.')
    const identities = new Set(constituents.map((row) => row.instrumentId))
    if (identities.size !== constituents.length)
      throw new Error('Atomic risk constituent identities must be unique.')
    if (maxGrossExposure !== undefined) {
      const unaffected = utilization
        .getCurrentUtilization()
        .positions.reduce(
          (sum, row) =>
            row.accountId === accountId && !identities.has(row.instrumentId)
              ? sum + row.absoluteNotional
              : sum,
          0,
        )
      const projected = constituents.reduce((sum, row) => sum + row.projectedPositionNotional, 0)
      if (unaffected + projected > maxGrossExposure)
        throw new Error('Projected gross account exposure exceeds the configured risk limit.')
    }
    const request = {
      ...primary,
      decisionId: operationId ?? `terminal:${operation}:${crypto.randomUUID()}`,
      requestedAt: Date.now(),
      notional: constituents.reduce((sum, row) => sum + row.notional, 0),
      estimatedSlippageBps: Math.max(...constituents.map((row) => row.estimatedSlippageBps)),
      marketDataAsOf: Math.min(...constituents.map((row) => row.marketDataAsOf)),
      legExposures: constituents.map((row) => ({
        instrumentId: row.instrumentId,
        session: row.session,
        side: row.side,
        quantity: row.quantity,
        notional: row.notional,
        projectedPositionQuantity: row.projectedPositionQuantity,
        projectedPositionNotional: row.projectedPositionNotional,
        estimatedSlippageBps: row.estimatedSlippageBps,
        marketDataAsOf: row.marketDataAsOf,
      })),
    }
    return request
  }

  const exactPosition = async (
    positionId: string,
    context: { symbol: SdkSymbolInfo; accountId?: string },
  ) => {
    refresh()
    while (refreshPromise) await refreshPromise
    if (refreshFailure !== undefined)
      throw new Error('Current broker position facts are unavailable for risk evaluation.')
    const position = latestState.positions.find((row) => row.id === positionId)
    if (
      !position ||
      !positive(position.quantity) ||
      position.side === 'flat' ||
      position.actionable === false
    )
      throw new Error('An exact actionable position is required for risk evaluation.')
    if (
      (context.accountId !== undefined && context.accountId !== position.accountId) ||
      !riskSymbolsMatch(context.symbol, position.symbol)
    )
      throw new Error('Position identity or account conflicts with the execution context.')
    requireAccountFacts(position.accountId)
    return position
  }

  const requests: TradingRiskDecisionRequestFactories = {
    async placeOrder(intent: Readonly<TradingPlaceOrderRiskIntent>) {
      if (
        intent.draft.accountId &&
        intent.context.accountId &&
        intent.draft.accountId !== intent.context.accountId
      ) {
        throw new Error('Draft account conflicts with the execution context account.')
      }
      const accountId =
        intent.draft.accountId ?? intent.context.accountId ?? latestState.activeAccountId
      if (!accountId) throw new Error('An exact account is required for risk evaluation.')
      return requestForOrder(intent.draft, accountId, 'placeOrder', intent.metadata?.operationId)
    },
    async reversePosition(intent: Readonly<TradingReversePositionRiskIntent>) {
      const position = await exactPosition(intent.positionId, intent.context)
      if (intent.options?.quantity !== undefined && intent.options.quantity !== position.quantity)
        throw new Error('Partial position reversal requires authoritative broker reversal sizing.')
      const side = position.side === 'long' ? 'sell' : 'buy'
      const quantity = position.quantity * 2
      const symbol = position.optionContract
        ? optionContractSymbol(position.optionContract)
        : position.symbol
      const request = await orderRequest({
        operation: 'reversePosition',
        accountId: position.accountId,
        symbol,
        instrumentId: riskPositionInstrumentId(position),
        side,
        orderType: 'market',
        quantity,
        ...(position.optionContract === undefined
          ? {}
          : { multiplier: position.optionContract.multiplier }),
        ...(intent.metadata?.operationId === undefined
          ? {}
          : { operationId: intent.metadata.operationId }),
      })
      const current = latestState.positions.find((row) => row.id === position.id)
      if (!current || current.quantity !== position.quantity || current.side !== position.side)
        throw new Error('Position changed while reversal risk facts were being acquired.')
      return request
    },
    async modifyPosition(intent: Readonly<TradingModifyPositionRiskIntent>) {
      const position = await exactPosition(intent.positionId, intent.context)
      const side = position.side === 'long' ? 'sell' : 'buy'
      const patch = intent.patch
      if (patch.trailingStopPips !== undefined || patch.guaranteedStop)
        throw new Error('Protection risk requires exact broker-native stop coverage facts.')
      const stops =
        patch.stopLosses ??
        (patch.stopLoss === null ? [] : patch.stopLoss ? [patch.stopLoss] : undefined)
      if (stops === undefined)
        throw new Error(
          'Protection risk requires an explicit complete replacement of stop coverage.',
        )
      let covered = 0
      for (const stop of stops) {
        if (
          !riskSymbolsMatch(stop.symbol, position.symbol) ||
          stop.side !== side ||
          (stop.accountId !== undefined && stop.accountId !== position.accountId) ||
          !['stop', 'stop-limit'].includes(stop.type) ||
          positive(stop.stopPrice) === undefined ||
          positive(stop.quantity) === undefined ||
          stop.cashQuantity !== undefined ||
          stop.strategyLegs?.length ||
          stop.optionLegs?.length
        )
          throw new Error(
            'Exact protective stop identity, direction, trigger and unit quantity are required.',
          )
        covered += stop.quantity
      }
      if (covered > position.quantity)
        throw new Error('Stop coverage cannot exceed the exact position quantity.')
      const quoteSymbol = position.optionContract
        ? optionContractSymbol(position.optionContract)
        : position.symbol
      const quote = await requireQuote(datafeed, quoteSymbol)
      if (!isNonNegative(quote.timestamp))
        throw new Error('Current protection quote timestamp is unavailable.')
      const current = latestState.positions.find((row) => row.id === position.id)
      if (!current || current.quantity !== position.quantity || current.side !== position.side)
        throw new Error('Position changed while protection risk facts were being acquired.')
      return {
        kind: 'position-protection-change',
        decisionId:
          intent.metadata?.operationId ?? `terminal:modifyPosition:${crypto.randomUUID()}`,
        requestedAt: Date.now(),
        executionEnvironment,
        accountId: position.accountId,
        instrumentId: riskPositionInstrumentId(position),
        session: position.symbol.session ?? 'regular',
        positionId: position.id,
        positionQuantity: position.quantity,
        projectedUnprotectedQuantity: position.quantity - covered,
        marketDataAsOf: quote.timestamp,
      }
    },
    async modifyOrder(intent: Readonly<TradingModifyOrderRiskIntent>) {
      const order = latestState.orders.find((candidate) => candidate.id === intent.orderId)
      if (!order) throw new Error(`The working order ${intent.orderId} is unavailable.`)
      if ((order.side !== 'buy' && order.side !== 'sell') || !isKnownOrderType(order.type))
        throw new Error('Unknown native order side or type is read-only and cannot be modified.')
      if (intent.context.accountId && intent.context.accountId !== order.accountId) {
        throw new Error('Order account conflicts with the execution context account.')
      }
      return requestForOrder(
        {
          ...order,
          side: order.side,
          type: order.type,
          ...(intent.patch.price === undefined ? {} : { price: intent.patch.price }),
          ...(intent.patch.stopPrice === undefined ? {} : { stopPrice: intent.patch.stopPrice }),
          ...((intent.patch.duration ?? order.duration)
            ? { duration: intent.patch.duration ?? order.duration }
            : {}),
        },
        order.accountId,
        'modifyOrder',
        intent.metadata?.operationId,
        intent.patch.quantity,
        intent.patch.price,
      )
    },
  }

  return {
    controller,
    requests,
    destroy() {
      destroyed = true
      unsubscribe?.()
      utilization.destroy()
      controller.destroy()
    },
  }
}

function supportsAtomicRisk(controller: RiskPolicyHostControllerApi): boolean {
  if (!('requestCapabilities' in controller)) return false
  const capabilities = controller.requestCapabilities
  return (
    typeof capabilities === 'object' &&
    capabilities !== null &&
    'atomicLegExposures' in capabilities &&
    capabilities.atomicLegExposures === true
  )
}

async function requireQuote(datafeed: MarketDataFeed, symbol: SdkSymbolInfo): Promise<Quote> {
  if (datafeed.getQuotes === undefined) throw new Error('The IBKR quote feed is unavailable.')
  const quote = (await datafeed.getQuotes({ symbols: [symbol] }))[0]
  if (quote === undefined) throw new Error(`IBKR returned no quote for ${symbol.ticker}.`)
  if (!riskSymbolsMatch(symbol, quote.symbol))
    throw new Error('IBKR risk quote has a different contract identity.')
  const marketDataType = quote.metadata?.marketDataType
  if (
    quote.status !== 'ok' ||
    (marketDataType !== undefined && marketDataType !== 'live' && marketDataType !== 1) ||
    positive(quote.bid) === undefined ||
    positive(quote.ask) === undefined
  ) {
    throw new Error(`Current live IBKR bid and ask prices are unavailable for ${symbol.ticker}.`)
  }
  return quote
}

function instrumentId(symbol: SdkSymbolInfo): string {
  if (symbol.type === 'option') {
    if (
      symbol.provider === MOCK_PROVIDER &&
      symbol.brokerSymbol?.trim() &&
      symbol.canonicalSymbol === `mock-option:${symbol.brokerSymbol}`
    )
      return symbol.canonicalSymbol
    const canonicalId = /^IBKR:([1-9][0-9]*)$/.exec(symbol.canonicalSymbol ?? '')?.[1]
    const brokerId = /^IBKR:([1-9][0-9]*)$/.exec(symbol.brokerSymbol ?? '')?.[1]
    const contractId = canonicalId ?? brokerId
    if (
      !contractId ||
      !Number.isSafeInteger(Number(contractId)) ||
      (canonicalId && brokerId && canonicalId !== brokerId)
    ) {
      throw new Error('An exact, matching IBKR option contract is required for risk evaluation.')
    }
    return `option:${contractId}`
  }
  return symbol.canonicalSymbol ?? symbol.brokerSymbol ?? symbol.ticker
}

function optionContractInstrumentId(
  contract: NonNullable<TradingState['positions'][number]['optionContract']>,
): string {
  if (
    contract.underlyingSymbolInfo.provider === MOCK_PROVIDER &&
    contract.brokerContractId !== undefined &&
    String(contract.brokerContractId).trim()
  )
    return `mock-option:${String(contract.brokerContractId)}`
  if (contract.brokerContractId !== undefined && String(contract.brokerContractId).trim() !== '') {
    return `option:${String(contract.brokerContractId)}`
  }
  return [
    'option',
    contract.currency ?? '',
    contract.underlying,
    contract.expiration,
    contract.strike,
    contract.right,
    contract.multiplier,
    contract.route ?? contract.exchange ?? '',
  ].join(':')
}

export function riskPositionInstrumentId(position: TradingState['positions'][number]): string {
  return position.optionContract
    ? optionContractInstrumentId(position.optionContract)
    : instrumentId(position.symbol)
}

function orderExposureFacts(
  order: TradingOrderDraft,
  modifiedQuantity?: number,
  modifiedPrice?: number,
) {
  if (order.cashQuantity !== undefined)
    throw new Error('Cash-quantity agent risk is not supported by the SDK quantity request.')
  const legs = order.strategyLegs?.length
    ? order.strategyLegs
    : order.optionLegs?.map((leg) => ({ ...leg, instrument: 'option' as const }))
  if (legs && legs.length > 1) {
    throw new Error(
      'Multi-leg agent risk requires atomic per-leg exposure, which the SDK does not support.',
    )
  }
  const leg = legs?.[0]
  if (!leg) {
    return {
      symbol: order.symbol,
      instrumentId: instrumentId(order.symbol),
      side: order.side,
      quantity: modifiedQuantity ?? order.quantity,
      ...((order.price ?? order.stopPrice) === undefined
        ? {}
        : { explicitPrice: order.price ?? order.stopPrice }),
    }
  }
  const ratio = leg.ratio ?? 1
  if (
    !Number.isSafeInteger(ratio) ||
    ratio <= 0 ||
    !Number.isFinite(leg.quantity) ||
    leg.quantity <= 0 ||
    leg.quantity / ratio !== order.quantity
  ) {
    throw new Error('Exact leg quantities and ratios are required for agent risk evaluation.')
  }
  const quantity = modifiedQuantity === undefined ? leg.quantity : modifiedQuantity * ratio
  if (leg.instrument === 'equity') {
    return {
      symbol: leg.symbolInfo,
      instrumentId: instrumentId(leg.symbolInfo),
      side: leg.side,
      quantity,
      ...(leg.price === undefined ? {} : { explicitPrice: leg.price }),
    }
  }
  const multiplier = positive(leg.contract.multiplier)
  if (multiplier === undefined) {
    throw new Error('An exact option contract multiplier is required for risk evaluation.')
  }
  const symbol = optionContractSymbol(leg.contract)
  return {
    symbol,
    instrumentId: instrumentId(symbol),
    side: leg.side,
    quantity,
    multiplier,
    ...((modifiedPrice ?? leg.price) === undefined
      ? {}
      : { explicitPrice: modifiedPrice ?? leg.price }),
  }
}

function optionContractSymbol(contract: TradingOptionContract): SdkSymbolInfo {
  const contractId = String(contract.brokerContractId ?? '')
  const exchange = contract.route ?? contract.exchange
  if (
    contract.underlyingSymbolInfo.provider === MOCK_PROVIDER &&
    contractId.trim() &&
    exchange?.trim() &&
    contract.currency?.trim()
  ) {
    // Agent projection intentionally hides custom-field values. Declared identity stays typed;
    // the broker account and exact simulator quote registry still authorize this namespace.
    return {
      ticker: contract.symbol ?? contractId,
      canonicalSymbol: `mock-option:${contractId}`,
      brokerSymbol: contractId,
      type: 'option',
      exchange,
      currency: contract.currency,
      provider: MOCK_PROVIDER,
    }
  }
  if (
    !/^[1-9][0-9]*$/.test(contractId) ||
    !Number.isSafeInteger(Number(contractId)) ||
    !exchange?.trim() ||
    !contract.currency?.trim()
  ) {
    throw new Error(
      'Exact option contract identity, exchange and currency are required for risk evaluation.',
    )
  }
  return {
    ticker: contract.underlying,
    canonicalSymbol: `IBKR:${contractId}`,
    brokerSymbol: `IBKR:${contractId}`,
    type: 'option',
    exchange,
    currency: contract.currency,
  }
}

async function requireMonetaryUnits(
  broker: TradingBrokerAdapter,
  symbol: SdkSymbolInfo,
  accountId: string,
): Promise<void> {
  if (!broker.getTradingSymbolInfo) return
  const rules = await broker.getTradingSymbolInfo({ symbol, accountId })
  if (!riskSymbolsMatch(symbol, rules.symbol))
    throw new Error('Broker monetary rules have a different contract identity.')
  if ('monetaryValueAvailable' in rules && rules.monetaryValueAvailable === false) {
    const reason =
      'monetaryValueUnavailableReason' in rules &&
      typeof rules.monetaryValueUnavailableReason === 'string'
        ? rules.monetaryValueUnavailableReason
        : 'Broker quote monetary units are unavailable for risk evaluation.'
    throw new Error(reason)
  }
}

async function contractMultiplier(
  broker: TradingBrokerAdapter,
  symbol: SdkSymbolInfo,
  accountId: string,
): Promise<number> {
  if (['stock', 'crypto', 'forex'].includes(symbol.type ?? '')) return 1
  if (!broker.getTradingSymbolInfo)
    throw new Error('Broker contract sizing is unavailable for risk evaluation.')
  const rules = await broker.getTradingSymbolInfo({ symbol, accountId })
  if (!riskSymbolsMatch(symbol, rules.symbol)) {
    throw new Error('Broker sizing has a different contract identity.')
  }
  const multiplier = positive(rules.contractMultiplier)
  if (multiplier === undefined)
    throw new Error('Broker contract multiplier is unavailable for risk evaluation.')
  return multiplier
}

function riskSymbolsMatch(requested: SdkSymbolInfo, received: SdkSymbolInfo): boolean {
  return (
    instrumentId(requested) === instrumentId(received) &&
    requested.type === received.type &&
    (!requested.exchange || requested.exchange === received.exchange) &&
    (!requested.currency || requested.currency === received.currency)
  )
}

async function positionUtilization(
  broker: TradingBrokerAdapter,
  state: TradingState,
  maxConversionAgeMs: number,
): Promise<RiskPolicyUtilization['positions']> {
  return Promise.all(
    state.positions.map(async (position) => {
      const quantity = Math.abs(position.quantity)
      const marketValue = numberField(position.customFields, 'marketValue')
      let notional: number
      if (marketValue !== undefined) notional = Math.abs(marketValue)
      else if (quantity === 0) notional = 0
      else {
        await requireMonetaryUnits(
          broker,
          position.optionContract ? optionContractSymbol(position.optionContract) : position.symbol,
          position.accountId,
        )
        const price = positive(position.marketPrice) ?? positive(position.averagePrice)
        if (price === undefined)
          throw new Error('Broker position price is unavailable for risk evaluation.')
        const multiplier = position.optionContract
          ? positive(position.optionContract.multiplier)
          : await contractMultiplier(broker, position.symbol, position.accountId)
        if (multiplier === undefined)
          throw new Error('Broker position contract multiplier is unavailable for risk evaluation.')
        notional = quantity * price * multiplier
      }
      const account = state.accounts.find((account) => account.id === position.accountId)
      const currency = position.optionContract?.currency ?? position.symbol.currency
      const valuationSymbol =
        position.optionContract && currency !== (account?.currency ?? account?.balance?.currency)
          ? optionContractSymbol(position.optionContract)
          : { ...position.symbol, ...(currency ? { currency } : {}) }
      return {
        accountId: position.accountId,
        instrumentId: riskPositionInstrumentId(position),
        absoluteQuantity: quantity,
        absoluteNotional:
          notional *
          (
            await accountCurrencyRate(
              broker,
              state,
              valuationSymbol,
              position.accountId,
              maxConversionAgeMs,
            )
          ).rate,
      }
    }),
  )
}

async function accountCurrencyRate(
  broker: TradingBrokerAdapter,
  state: TradingState,
  symbol: SdkSymbolInfo,
  accountId: string,
  maxAgeMs: number,
): Promise<{ rate: number; asOf?: number }> {
  const account = state.accounts.find((account) => account.id === accountId)
  const fromCurrency = symbol.currency?.trim().toUpperCase()
  const toCurrency = (account?.currency ?? account?.balance?.currency)?.trim().toUpperCase()
  if (!fromCurrency || !toCurrency)
    throw new Error(
      'Exact instrument and account currency facts are unavailable for risk evaluation.',
    )
  if (fromCurrency === toCurrency) return { rate: 1 }
  if (!broker.getTradingSymbolInfo)
    throw new Error('Broker account currency conversion is unavailable for risk evaluation.')
  const rules = await broker.getTradingSymbolInfo({ symbol, accountId })
  const conversion = rules.accountCurrencyConversion
  const now = Date.now()
  if (
    !riskSymbolsMatch(symbol, rules.symbol) ||
    !conversion ||
    conversion.fromCurrency.trim().toUpperCase() !== fromCurrency ||
    conversion.toCurrency.trim().toUpperCase() !== toCurrency ||
    positive(conversion.rate) === undefined ||
    !isNonNegative(conversion.asOf) ||
    conversion.asOf > now ||
    now - conversion.asOf > maxAgeMs ||
    !conversion.source.trim()
  ) {
    throw new Error('A fresh currency conversion rate for your account is unavailable.')
  }
  return { rate: conversion.rate, asOf: conversion.asOf }
}

function numberField(
  fields: Readonly<Record<string, unknown>> | undefined,
  name: string,
): number | undefined {
  const value = fields?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isNonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

function isKnownOrderType(value: string): value is TradingOrderDraft['type'] {
  return SUPPORTED_ORDER_TYPES.some((type) => type === value)
}
