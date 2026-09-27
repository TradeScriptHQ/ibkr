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
  TradingOrderSide,
  TradingPlaceOrderRiskIntent,
  TradingRiskDecisionRequestFactories,
  TradingState,
  Unsubscribe,
} from '@tradescript/pro/sdk'

type AgentTradingBootstrap = TradeScriptBootstrapResponse['paperTrading']

export interface ConnectionRiskAuthority {
  readonly controller: RiskPolicyHostControllerApi
  readonly requests: TradingRiskDecisionRequestFactories
  destroy(): void
}

class BrokerUtilizationSource implements RiskPolicyUtilizationSource {
  readonly #listeners = new Set<(snapshot: RiskPolicyUtilization) => void>()
  readonly #openingEquity = new Map<string, number>()
  #snapshot: RiskPolicyUtilization
  #revision = 0

  constructor(state: TradingState) {
    for (const account of state.accounts) {
      const equity = account.balance?.equity
      if (isNonNegative(equity)) this.#openingEquity.set(account.id, equity)
    }
    this.#snapshot = this.#project(state)
  }

  getCurrentUtilization(): RiskPolicyUtilization {
    return this.#snapshot
  }

  subscribe(callback: (snapshot: RiskPolicyUtilization) => void): Unsubscribe {
    this.#listeners.add(callback)
    return () => this.#listeners.delete(callback)
  }

  update(state: TradingState): void {
    this.#snapshot = this.#project(state)
    for (const listener of this.#listeners) listener(this.#snapshot)
  }

  destroy(): void {
    this.#listeners.clear()
  }

  #project(state: TradingState): RiskPolicyUtilization {
    const asOf = Date.now()
    const accounts = state.accounts.map((account) => {
      const currentEquity = account.balance?.equity
      const openingEquity = this.#openingEquity.get(account.id)
      const createdAfter = asOf - 60_000
      return {
        accountId: account.id,
        dailyLoss:
          isNonNegative(openingEquity) && isNonNegative(currentEquity)
            ? Math.max(0, openingEquity - currentEquity)
            : 0,
        ordersInLastMinute: state.orders.filter(
          (order) =>
            order.accountId === account.id &&
            isNonNegative(order.createdAt) &&
            order.createdAt >= createdAfter &&
            order.createdAt <= asOf,
        ).length,
      }
    })
    const positions = state.positions.map((position) => {
      const quantity = Math.abs(position.quantity)
      const marketValue = numberField(position.customFields, 'marketValue')
      const price = position.marketPrice ?? position.averagePrice
      return {
        accountId: position.accountId,
        instrumentId: riskPositionInstrumentId(position),
        absoluteQuantity: quantity,
        absoluteNotional:
          marketValue === undefined
            ? isNonNegative(price)
              ? quantity * price
              : 0
            : Math.abs(marketValue),
      }
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
  const utilization = new BrokerUtilizationSource(state)
  const controller = sdk.trading.createRiskPolicyController({
    policy: {
      autonomyMode: executionEnvironment === 'live' ? 'bounded-live-auto' : 'paper-auto',
      accounts: { mode: 'allow-list', values: config.allowedAccountIds },
      instruments: { mode: 'all' },
      sessions: { mode: 'all' },
      sides: { mode: 'all' },
      orderTypes: { mode: 'all' },
      limits: { ...config.limits },
    },
    utilization,
    receiptCapacity: 1_000,
  })

  let latestState = state
  let refreshPending = false
  let destroyed = false
  const refresh = () => {
    if (refreshPending || destroyed) return
    refreshPending = true
    void broker
      .getState()
      .then((nextState) => {
        latestState = nextState
        utilization.update(nextState)
      })
      .finally(() => {
        refreshPending = false
      })
  }
  const unsubscribe = broker.subscribe?.(() => refresh())

  const orderRequest = async (input: {
    operation: string
    accountId: string
    symbol: SdkSymbolInfo
    instrumentId: string
    side: TradingOrderSide
    orderType: TradingPlaceOrderRiskIntent['draft']['type']
    quantity: number
    explicitPrice?: number
    operationId?: string
    timeInForce?: TradingPlaceOrderRiskIntent['draft']['duration']
  }): Promise<RiskOrderDecisionRequest> => {
    const quote = await requireQuote(datafeed, input.symbol)
    // The decision is requested after its asynchronous market-data facts arrive.
    const requestedAt = Date.now()
    const price =
      positive(input.explicitPrice) ??
      (input.side === 'buy'
        ? (positive(quote.ask) ??
          positive(quote.last) ??
          positive(quote.bid) ??
          positive(quote.previousClose))
        : (positive(quote.bid) ??
          positive(quote.last) ??
          positive(quote.ask) ??
          positive(quote.previousClose)))
    if (price === undefined || !isNonNegative(quote.timestamp)) {
      throw new Error(`Current IBKR price facts are unavailable for ${input.symbol.ticker}.`)
    }
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
      notional: input.quantity * price,
      projectedPositionQuantity: projectedQuantity,
      projectedPositionNotional: projectedQuantity * price,
      estimatedSlippageBps,
      marketDataAsOf: quote.timestamp,
    }
  }

  const requests: TradingRiskDecisionRequestFactories = {
    async placeOrder(intent: Readonly<TradingPlaceOrderRiskIntent>) {
      const accountId =
        intent.draft.accountId ?? intent.context.accountId ?? latestState.activeAccountId
      if (!accountId) throw new Error('An exact account is required for risk evaluation.')
      return orderRequest({
        operation: 'placeOrder',
        accountId,
        symbol: intent.draft.symbol,
        instrumentId: riskOrderInstrumentId(intent.draft),
        side: intent.draft.side,
        orderType: intent.draft.type,
        quantity: intent.draft.quantity,
        ...((intent.draft.price ?? intent.draft.stopPrice)
          ? { explicitPrice: intent.draft.price ?? intent.draft.stopPrice }
          : {}),
        ...(intent.metadata === undefined ? {} : { operationId: intent.metadata.operationId }),
        ...(intent.draft.duration === undefined ? {} : { timeInForce: intent.draft.duration }),
      })
    },
    async modifyOrder(intent: Readonly<TradingModifyOrderRiskIntent>) {
      const order = latestState.orders.find((candidate) => candidate.id === intent.orderId)
      if (!order) throw new Error(`The working order ${intent.orderId} is unavailable.`)
      return orderRequest({
        operation: 'modifyOrder',
        accountId: order.accountId,
        symbol: order.symbol,
        instrumentId: riskOrderInstrumentId(order),
        side: order.side,
        orderType: order.type,
        quantity: intent.patch.quantity ?? order.quantity,
        ...((intent.patch.price ?? intent.patch.stopPrice ?? order.price ?? order.stopPrice)
          ? {
              explicitPrice:
                intent.patch.price ?? intent.patch.stopPrice ?? order.price ?? order.stopPrice,
            }
          : {}),
        ...(intent.metadata === undefined ? {} : { operationId: intent.metadata.operationId }),
        ...((intent.patch.duration ?? order.duration)
          ? { timeInForce: intent.patch.duration ?? order.duration }
          : {}),
      })
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

async function requireQuote(datafeed: MarketDataFeed, symbol: SdkSymbolInfo): Promise<Quote> {
  if (datafeed.getQuotes === undefined) throw new Error('The IBKR quote feed is unavailable.')
  const deadline = Date.now() + 3_000
  let quote: Quote | undefined
  do {
    quote = (await datafeed.getQuotes({ symbols: [symbol] }))[0]
    if (quote !== undefined && quoteHasRiskPrice(quote)) return quote
    await new Promise((resolve) => window.setTimeout(resolve, 150))
  } while (Date.now() < deadline)

  // A fresh gateway process returns one subscription-pending snapshot before
  // TWS publishes its first quote. If that tick is delayed or unavailable,
  // use the latest real IBKR bar as the paper-risk price instead of blocking
  // the order ticket indefinitely.
  const endTime = Date.now()
  const history = await datafeed
    .loadBars(symbol, '5m', {
      startTime: endTime - 7 * 24 * 60 * 60 * 1_000,
      endTime,
      barCount: 8,
      initialDataLoad: true,
      loadDirection: 'initial',
    })
    .catch(() => undefined)
  const latestBar = history?.bars.at(-1)
  if (latestBar !== undefined && positive(latestBar.close) !== undefined) {
    return {
      ...(quote ?? { symbol }),
      last: latestBar.close,
      timestamp: latestBar.time,
    }
  }

  if (quote === undefined) throw new Error(`IBKR returned no quote for ${symbol.ticker}.`)
  return quote
}

function quoteHasRiskPrice(quote: Quote): boolean {
  return [quote.ask, quote.last, quote.bid, quote.previousClose].some(
    (value) => positive(value) !== undefined,
  )
}

function instrumentId(symbol: SdkSymbolInfo): string {
  return symbol.canonicalSymbol ?? symbol.brokerSymbol ?? symbol.ticker
}

function optionContractInstrumentId(
  contract: NonNullable<TradingState['positions'][number]['optionContract']>,
): string {
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

function riskOrderInstrumentId(
  order: Pick<TradingPlaceOrderRiskIntent['draft'], 'symbol' | 'optionLegs' | 'strategyLegs'>,
): string {
  const optionContracts = [
    ...(order.optionLegs ?? []).map((leg) => leg.contract),
    ...(order.strategyLegs ?? []).flatMap((leg) =>
      leg.instrument === 'option' ? [leg.contract] : [],
    ),
  ]
  const firstOptionContract = optionContracts[0]
  if (firstOptionContract === undefined) return instrumentId(order.symbol)
  if (optionContracts.length === 1) return optionContractInstrumentId(firstOptionContract)
  return `option-strategy:${optionContracts.map(optionContractInstrumentId).join('|')}`
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
