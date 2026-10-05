import type {
  Bar,
  ChartInterval,
  MarketDataFeed,
  OptionSeriesSnapshot,
  Quote,
  SdkMarketDepth,
  SdkSymbolInfo,
  TimeAndSalesEntry,
  TradingAccount,
  TradingAccountManagerInfo,
  TradingBrokerAdapter,
  TradingBulkActionOptions,
  TradingEvent,
  TradingFeatureSet,
  TradingOptionContract,
  TradingPosition,
  TradingState,
} from '@tradescript/pro/sdk'
import { MOCK_PROVIDER } from './identity.js'
import {
  createSyntheticOrderEngine,
  exactOptionSymbol,
  SYNTHETIC_PIP_SIZE,
  type SyntheticQuoteUpdate,
} from './order-engine.js'

export { MOCK_PROVIDER }

export const MOCK_ACCOUNT_ID = 'MOCK-PAPER'

const STARTING_CASH = 100_000
const COMMISSION = 1
const BASE_PRICES: Record<string, number> = {
  AAPL: 200,
  MSFT: 420,
  NVDA: 180,
  TSLA: 350,
  SPY: 650,
}

export interface LocalSimulation {
  readonly broker: TradingBrokerAdapter
  readonly datafeed: MarketDataFeed
  /** Advances only this explicitly synthetic local market. */
  advanceQuote(symbol: SdkSymbolInfo, update: SyntheticQuoteUpdate): void
}

export interface LocalSimulationOptions {
  readonly now?: () => number
  readonly maxFillQuantity?: number
  readonly createDefaultAccountManagerInfo?: () => TradingAccountManagerInfo
}

export function createLocalSimulation(options: LocalSimulationOptions = {}): LocalSimulation {
  const now = options.now ?? Date.now
  const optionContracts = new Map<string, TradingOptionContract>()
  const overrides = new Map<string, SyntheticQuoteUpdate>()
  const listeners = new Set<(symbol: SdkSymbolInfo, quantity?: number) => void>()
  const datafeed = createMockMarketDatafeed(now, optionContracts, overrides)
  const market = {
    quote: (symbol: SdkSymbolInfo) => mockQuote(symbol, now, optionContracts, overrides),
    subscribe(listener: (symbol: SdkSymbolInfo, quantity?: number) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    broker: createMockBroker(
      now,
      options.createDefaultAccountManagerInfo,
      optionContracts,
      market,
      options.maxFillQuantity,
    ),
    datafeed,
    advanceQuote(symbol, update) {
      if (
        symbol.provider !== MOCK_PROVIDER ||
        (symbol.type !== 'stock' && symbol.type !== 'option') ||
        market.quote(symbol).status !== 'ok'
      )
        throw new Error('Only an exact available synthetic instrument can advance.')
      if (
        ![update.last, update.bid, update.ask].every(
          (value) => Number.isFinite(value) && value > 0,
        ) ||
        update.bid > update.ask ||
        (update.availableQuantity !== undefined &&
          (!Number.isInteger(update.availableQuantity) || update.availableQuantity < 0))
      )
        throw new Error('Invalid synthetic quote or executable quantity.')
      overrides.set(instrumentKey(symbol), { ...update })
      for (const listener of listeners) listener(symbol, update.availableQuantity)
      for (const contract of optionContracts.values()) {
        if (instrumentKey(contract.underlyingSymbolInfo) !== instrumentKey(symbol)) continue
        const exact = exactOptionSymbol(contract)
        if (!overrides.has(instrumentKey(exact))) for (const listener of listeners) listener(exact)
      }
    },
  }
}

function createMockMarketDatafeed(
  now: () => number,
  optionContracts: Map<string, TradingOptionContract>,
  overrides: Map<string, SyntheticQuoteUpdate>,
): MarketDataFeed {
  const resolve = (selection: string | SdkSymbolInfo): SdkSymbolInfo => {
    if (typeof selection !== 'string') return selection
    const ticker = selection.toUpperCase()
    return {
      ticker,
      canonicalSymbol: `mock:${ticker}`,
      brokerSymbol: ticker,
      name: ticker === 'AAPL' ? 'APPLE INC' : ticker,
      exchange: 'SMART',
      listedExchange: ticker === 'SPY' ? 'ARCA' : 'NASDAQ',
      currency: 'USD',
      type: 'stock',
      provider: MOCK_PROVIDER,
    }
  }
  const priceFor = (selection: string | SdkSymbolInfo) =>
    overrides.get(instrumentKey(resolve(selection)))?.last ??
    BASE_PRICES[typeof selection === 'string' ? selection.toUpperCase() : selection.ticker] ??
    100
  const quoteFor = (selection: string | SdkSymbolInfo): Quote =>
    mockQuote(resolve(selection), now, optionContracts, overrides)
  const depthFor = (symbol: SdkSymbolInfo, levels = 10): SdkMarketDepth => {
    const timestamp = now()
    const last = priceFor(symbol)
    return {
      symbol,
      bids: Array.from({ length: levels }, (_, index) => ({
        price: round(last - 0.05 - index * 0.05),
        size: 100 + index * 25,
        exchange: index % 2 === 0 ? 'NASDAQ' : 'ARCA',
      })),
      asks: Array.from({ length: levels }, (_, index) => ({
        price: round(last + 0.05 + index * 0.05),
        size: 120 + index * 20,
        exchange: index % 2 === 0 ? 'NASDAQ' : 'BATS',
      })),
      timestamp,
      quality: {
        mode: 'snapshot',
        observedAt: timestamp,
        sourceTime: timestamp,
        continuity: 'not-applicable',
        resync: 'not-required',
      },
      metadata: { provider: MOCK_PROVIDER, synthetic: true },
    }
  }
  const tapeFor = (symbol: SdkSymbolInfo, limit = 40): TimeAndSalesEntry[] => {
    const last = priceFor(symbol)
    return Array.from({ length: limit }, (_, index) => ({
      time: now() - (limit - index) * 1_000,
      price: round(last + ((index % 7) - 3) * 0.02),
      size: 10 + (index % 6) * 15,
      aggressor: index % 3 === 0 ? 'buy' : index % 3 === 1 ? 'sell' : 'between',
      venue: index % 2 === 0 ? 'NASDAQ' : 'ARCA',
      sequence: index + 1,
      metadata: { synthetic: true },
    }))
  }
  const optionSnapshot = (
    selection: string | SdkSymbolInfo,
    requestedExpiration?: string,
  ): OptionSeriesSnapshot => {
    const symbol = resolve(selection)
    const timestamp = now()
    const expiration = requestedExpiration ?? futureExpiration(timestamp)
    const base = priceFor(symbol)
    const strikes = [-10, -5, 0, 5, 10].map((offset) => base + offset)
    const contracts = strikes.flatMap((strike) =>
      (['CALL', 'PUT'] as const).map((type) => {
        const intrinsic = type === 'CALL' ? Math.max(0, base - strike) : Math.max(0, strike - base)
        const mark = round(Math.max(0.5, intrinsic + 2.5 - Math.abs(base - strike) * 0.05))
        return {
          code: `${symbol.ticker}-${expiration}-${type[0]}-${strike}`,
          underlying_symbol: symbol.ticker,
          bid_price: round(mark - 0.01),
          ask_price: round(mark + 0.01),
          last_price: mark,
          implied_volatility: 0.24,
          delta: type === 'CALL' ? 0.5 : -0.5,
          gamma: 0.03,
          theta: -0.04,
          vega: 0.12,
          expiration: Number(expiration.replaceAll('-', '')),
          expiration_date: expiration,
          type,
          strike_price: strike,
          multiplier: 100,
          open_interest: 1_000,
          volume: 250,
          bid_size: 25,
          ask_size: 30,
          provider: MOCK_PROVIDER,
          last_update: timestamp,
          metrics: { synthetic: true },
        }
      }),
    )
    return {
      symbol: symbol.ticker,
      provider: MOCK_PROVIDER,
      quote_timestamp: timestamp,
      expirations: [expiration],
      strikes,
      contracts,
      quote_freshness: { last_update: timestamp, age_ms: 0, status: 'ok' },
      field_provenance: {
        prices: { source: MOCK_PROVIDER, endpoint: 'in-memory', transform: 'deterministic' },
      },
      field_availability: {
        bid_price: true,
        ask_price: true,
        greeks: true,
        open_interest: true,
        volume: true,
      },
    }
  }

  return {
    onReady: () => ({
      supportsSearch: true,
      supportsRealTime: true,
      supportsServerTime: true,
      supportsQuotes: true,
      supportsDepth: true,
      supportsTimeAndSales: true,
      supportsSessionInfo: true,
      supportsOptionContracts: true,
      supportsOptionQuotes: true,
      supportedIntervals: [
        '1s',
        '5s',
        '10s',
        '15s',
        '30s',
        '1m',
        '2m',
        '3m',
        '5m',
        '10m',
        '15m',
        '30m',
        '1H',
        '2H',
        '4H',
        '1D',
        '1W',
        '1M',
      ],
    }),
    async searchSymbols(request) {
      return Object.keys(BASE_PRICES)
        .filter((ticker) => ticker.includes(request.searchText.toUpperCase()))
        .slice(0, request.limit ?? 10)
        .map((ticker) => ({
          symbol: resolve(ticker),
          displayName: ticker,
          description: `Synthetic ${ticker} fixture`,
          provider: MOCK_PROVIDER,
        }))
    },
    async resolveSymbol(selection) {
      return resolve(selection)
    },
    async loadBars(symbol, interval: ChartInterval, request) {
      const intervalMs = intervalMilliseconds(interval)
      const end = Math.min(request.endTime, now())
      const count = Math.max(1, request.barCount)
      const first = Math.max(request.startTime, end - (count - 1) * intervalMs)
      const bars: Bar[] = []
      for (let time = first; time <= end && bars.length < count; time += intervalMs) {
        const index = bars.length
        const progress = count === 1 ? 1 : index / (count - 1)
        const baseline =
          priceFor(symbol) - 3 + progress * 3 + Math.sin(index / 6) * 0.7 * (1 - progress)
        const open = round(baseline)
        const close = round(baseline + Math.sin(index / 3) * 0.22 * (1 - progress))
        bars.push({
          time,
          open,
          high: round(Math.max(open, close) + 0.25),
          low: round(Math.min(open, close) - 0.25),
          close,
          volume: 20_000 + (index % 12) * 2_500,
          state: time + intervalMs > now() ? 'developing' : 'final',
        })
      }
      return { bars, hasOlder: false, hasNewer: false }
    },
    async getServerTime() {
      return now()
    },
    async resolveSessionInfo(request) {
      const timestamp = now()
      return {
        symbol: request.symbol,
        timezone: 'America/New_York',
        currentState: 'regular',
        asOf: timestamp,
        upcoming: [
          {
            opensAt: timestamp - 60 * 60_000,
            closesAt: timestamp + 7 * 60 * 60_000,
            state: 'regular',
          },
        ],
        note: 'Synthetic always-open paper session',
        metadata: { provider: MOCK_PROVIDER, synthetic: true },
      }
    },
    subscribeSessionInfo(subscription, callback) {
      void this.resolveSessionInfo?.(subscription).then(callback)
      return () => undefined
    },
    async getQuotes(request) {
      return request.symbols.map(quoteFor)
    },
    subscribeQuotes(subscription, callback) {
      const emit = () => callback(subscription.symbols.map(quoteFor))
      emit()
      const timer = setInterval(emit, 2_000)
      return () => clearInterval(timer)
    },
    async getDepth(request) {
      return depthFor(request.symbol, request.levels)
    },
    subscribeDepth(subscription, callback) {
      callback(depthFor(subscription.symbol, subscription.levels))
      return () => undefined
    },
    async getTimeAndSales(request) {
      return tapeFor(request.symbol, request.limit)
    },
    subscribeTimeAndSales(subscription, callback) {
      const timestamp = now()
      callback({
        symbol: subscription.symbol,
        prints: tapeFor(subscription.symbol, Math.min(subscription.limit ?? 40, 40)),
        snapshot: true,
        quality: {
          mode: 'snapshot',
          observedAt: timestamp,
          sourceTime: timestamp,
          continuity: 'not-applicable',
          resync: 'not-required',
        },
      })
      return () => undefined
    },
    async getOptionContracts(request) {
      return optionSnapshot(request.symbol, request.expiration)
    },
    async getOptionQuotes(request) {
      return optionSnapshot(request.symbol, request.expiration)
    },
  }
}

function createMockBroker(
  now: () => number,
  createDefaultAccountManagerInfo: (() => TradingAccountManagerInfo) | undefined,
  optionContracts: Map<string, TradingOptionContract>,
  market: Parameters<typeof createSyntheticOrderEngine>[2],
  maxFillQuantity: number | undefined,
): TradingBrokerAdapter {
  const subscribers = new Set<(event: TradingEvent) => void>()
  let host: Parameters<NonNullable<TradingBrokerAdapter['connect']>>[0] | undefined
  let sequence = 0
  const account = mockAccount()
  const state: TradingState = {
    connectionStatus: 'connected',
    activeAccountId: MOCK_ACCOUNT_ID,
    features: mockFeatures(),
    accounts: [account],
    orders: [],
    ordersHistory: [],
    positions: [],
    executions: [],
    messages: [],
  }
  const cloneState = () => structuredClone(state)
  const publish = () => {
    recomputeAccount()
    const snapshot = cloneState()
    host?.setState(snapshot)
    for (const listener of subscribers) listener({ type: 'state', state: snapshot })
  }
  const recomputeAccount = () => {
    const cash = account.balance?.cash ?? STARTING_CASH
    const marketValue = state.positions.reduce(
      (sum, position) =>
        sum +
        signedPosition(position) *
          (position.marketPrice ?? position.averagePrice ?? 0) *
          (position.optionContract?.multiplier ?? 1),
      0,
    )
    const equity = money(cash + marketValue)
    const grossMarketValue = state.positions.reduce(
      (sum, position) =>
        sum +
        position.quantity *
          (position.marketPrice ?? position.averagePrice ?? 0) *
          (position.optionContract?.multiplier ?? 1),
      0,
    )
    account.balance = {
      ...account.balance,
      cash: money(cash),
      buyingPower: Math.max(0, equity * 4),
      equity,
      marginUsed: money(grossMarketValue * 0.25),
      currency: 'USD',
    }
    account.customFields = {
      ...account.customFields,
      availableFunds: account.balance.buyingPower,
      dailyPnl: money(equity - STARTING_CASH),
    }
    account.pnl = {
      totalPnl: equity - STARTING_CASH,
      pnlPercent: ((equity - STARTING_CASH) / STARTING_CASH) * 100,
      realizedPnl: state.executions.reduce(
        (sum, execution) => sum + Number(execution.metadata?.realizedPnl ?? 0),
        0,
      ),
      unrealizedPnl: state.positions.reduce(
        (sum, position) => sum + Number(position.customFields?.unrealizedPnl ?? 0),
        0,
      ),
      currency: 'USD',
    }
  }
  const engine = createSyntheticOrderEngine(
    state,
    MOCK_ACCOUNT_ID,
    market,
    optionContracts,
    now,
    publish,
    maxFillQuantity,
  )

  const broker: TradingBrokerAdapter = {
    executionEnvironment: 'paper',
    async connect(nextHost) {
      host = nextHost
      nextHost.setState(cloneState())
      return {
        status: 'connected',
        connectionType: 'streaming',
        serverTime: now(),
        message: 'Synthetic local paper exchange',
      }
    },
    async disconnect() {
      host = undefined
    },
    getConnectionStatus: () => 'connected',
    getFeatures: () => mockFeatures(),
    async getState() {
      recomputeAccount()
      return cloneState()
    },
    subscribe(callback) {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    ...(createDefaultAccountManagerInfo
      ? { getAccountManagerInfo: createDefaultAccountManagerInfo }
      : {}),
    async listAccounts() {
      return structuredClone(state.accounts)
    },
    async setActiveAccount(accountId) {
      if (accountId !== MOCK_ACCOUNT_ID) throw new Error(`Unknown simulated account: ${accountId}`)
    },
    async isTradable(context) {
      const symbolRules = await broker.getTradingSymbolInfo?.(context)
      return { tradable: true, ...(symbolRules ? { symbolRules } : {}) }
    },
    async getTradingSymbolInfo(context) {
      const isOption = context.symbol.type === 'option'
      const option = optionContracts.get(context.symbol.brokerSymbol ?? '')
      return {
        symbol: context.symbol,
        ...(context.accountId ? { accountId: context.accountId } : {}),
        currency: 'USD',
        minQuantity: 1,
        maxQuantity: 10_000,
        quantityStep: 1,
        minNotional: 1,
        priceStep: 0.01,
        pipSize: SYNTHETIC_PIP_SIZE,
        ...(isOption
          ? option
            ? { contractMultiplier: option.multiplier }
            : {}
          : { contractMultiplier: 1 }),
        supportedOrderTypes: isOption
          ? ['market', 'limit']
          : ['market', 'limit', 'stop', 'stop-limit', 'trailing-stop'],
        supportedDurations: [
          { type: 'day', label: 'DAY' },
          { type: 'gtc', label: 'GTC' },
        ],
        oca: {
          behaviors: [
            { value: 'cancel-with-block', label: 'Cancel siblings on fill' },
            { value: 'reduce-with-block', label: 'Reduce siblings on fill' },
            {
              value: 'reduce-without-block',
              label: 'Reduce siblings on fill (synthetic sequential execution)',
            },
          ],
          defaultBehavior: 'cancel-with-block',
        },
        supportsMarketBrackets: !isOption,
        supportsMultipleExitLevels: !isOption,
        supportsUnpairedExitLevels: !isOption,
        supportsStopLoss: !isOption,
        supportsTrailingStop: !isOption,
        supportsShortSelling: true,
        marginable: true,
      }
    },
    async resolveOptionContract(request) {
      if (request.accountId && request.accountId !== MOCK_ACCOUNT_ID)
        throw new Error('Unknown synthetic option account.')
      const source = request.contract
      if (
        source.underlyingSymbolInfo.provider !== MOCK_PROVIDER ||
        source.underlyingSymbolInfo.ticker !== source.underlying ||
        source.underlyingSymbolInfo.canonicalSymbol !== `mock:${source.underlying}` ||
        !Number.isFinite(source.strike) ||
        source.strike <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(source.expiration) ||
        !Number.isFinite(Date.parse(`${source.expiration}T00:00:00Z`)) ||
        (source.right !== 'call' && source.right !== 'put') ||
        BASE_PRICES[source.underlying] === undefined ||
        source.currency !== 'USD' ||
        source.multiplier !== 100
      )
        throw new Error('The exact option contract is unavailable from the local simulator.')
      const id = String(source.brokerContractId ?? optionKey(source))
      const contract: TradingOptionContract = {
        ...source,
        symbol: source.symbol ?? optionKey(source),
        brokerContractId: id,
        exchange: source.exchange ?? 'SMART',
        route: 'LOCAL',
        customFields: { ...source.customFields, provider: MOCK_PROVIDER, synthetic: true },
      }
      const existing = optionContracts.get(id)
      if (
        existing &&
        (existing.underlying !== contract.underlying ||
          existing.expiration !== contract.expiration ||
          existing.strike !== contract.strike ||
          existing.right !== contract.right ||
          existing.currency !== contract.currency ||
          existing.multiplier !== contract.multiplier)
      )
        throw new Error('Synthetic option identity conflicts with an existing contract.')
      optionContracts.set(id, contract)
      return {
        contract,
        tradable: true,
      }
    },
    async getOrdersHistory(request = {}) {
      return structuredClone(
        (state.ordersHistory ?? []).filter(
          (order) => !request.accountId || order.accountId === request.accountId,
        ),
      )
    },
    async previewOrder(draft, context) {
      try {
        engine.validate(draft, context)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { accepted: false, message, errors: [message] }
      }
      const leg = draft.optionLegs?.[0]
      const quote = leg ? market.quote(exactOptionSymbol(leg.contract)) : undefined
      const price = leg
        ? (leg.price ?? draft.price ?? (leg.side === 'buy' ? quote?.ask : quote?.bid))
        : (draft.price ?? (draft.side === 'buy' ? context.ask : context.bid) ?? context.lastPrice)
      const quantity = draft.optionLegs?.[0]?.quantity ?? draft.quantity
      const multiplier = draft.optionLegs?.[0]?.contract.multiplier ?? 1
      if (!Number.isFinite(price) || Number(price) <= 0) {
        return { accepted: false, message: 'A positive simulated price is required.' }
      }
      return {
        accepted: true,
        confirmId: `mock-confirm-${++sequence}`,
        estimatedCommission: COMMISSION,
        estimatedFees: 0,
        estimatedMargin: Number(price) * quantity * multiplier * 0.25,
        message: 'Previewed on the synthetic local paper exchange.',
      }
    },
    async previewModifyOrder(orderId, patch, context) {
      try {
        engine.previewModify(orderId, patch, context)
        return { accepted: true, confirmId: `mock-modify-${++sequence}` }
      } catch (error) {
        return { accepted: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async placeOrder(draft, context) {
      return engine.place(draft, context)
    },
    async modifyOrder(orderId, patch, context) {
      return engine.modify(orderId, patch, context)
    },
    async cancelOrder(orderId) {
      engine.cancel(orderId)
    },
    async cancelOrders(orderIds, context, financialOptions) {
      for (const orderId of orderIds) await broker.cancelOrder?.(orderId, context, financialOptions)
    },
    async cancelAllOrders(options) {
      let cancelled = 0
      for (const order of state.orders) {
        if (
          !['working', 'partially-filled', 'inactive'].includes(order.status) ||
          !inBulkScope(order, options)
        )
          continue
        engine.cancel(order.id)
        cancelled += 1
      }
      publish()
      return cancelled
    },
    async previewClosePosition(positionId) {
      return {
        accepted: state.positions.some((position) => position.id === positionId),
        message: `Close simulated position ${positionId}`,
      }
    },
    async closePosition(positionId, context, options = {}) {
      engine.close(positionId, context, options.quantity)
    },
    async modifyPosition(positionId, patch, context) {
      return engine.modifyPosition(positionId, patch, context)
    },
    async reversePosition(positionId, context, options) {
      if (
        options?.quantity !== undefined &&
        options.quantity !==
          state.positions.find((position) => position.id === positionId)?.quantity
      )
        throw new Error(
          'Synthetic partial reversal is unavailable; reverse the full owned position.',
        )
      engine.reverse(positionId, context)
    },
    async flattenPositions(contexts, options) {
      const positions = state.positions.filter((position) => inBulkScope(position, options))
      // This is one simulator-owned bulk operation. Resolve every exact context and executable
      // close price first so a missing later context cannot leave an earlier position flattened.
      const plan = positions.map((position) => {
        const context = contexts.find(
          (candidate) =>
            instrumentKey(candidate.symbol) === instrumentKey(position.symbol) &&
            (candidate.accountId === undefined || candidate.accountId === position.accountId),
        )
        if (!context) throw new Error(`No price context for ${position.symbol.ticker}`)
        const price = (position.side === 'long' ? context.bid : context.ask) ?? context.lastPrice
        if (price === undefined || !Number.isFinite(price) || price <= 0)
          throw new Error(`No executable price context for ${position.symbol.ticker}`)
        return { position, context }
      })
      for (const { position, context } of plan) {
        await broker.closePosition?.(position.id, context)
      }
      return positions.length
    },
  }
  return broker
}

function mockAccount(): TradingAccount {
  return {
    id: MOCK_ACCOUNT_ID,
    name: 'Local Simulation',
    brokerName: MOCK_PROVIDER,
    currency: 'USD',
    isActive: true,
    balance: {
      cash: STARTING_CASH,
      buyingPower: STARTING_CASH * 4,
      equity: STARTING_CASH,
      marginUsed: 0,
      currency: 'USD',
    },
    pnl: { totalPnl: 0, pnlPercent: 0, realizedPnl: 0, unrealizedPnl: 0, currency: 'USD' },
    capabilities: {
      supportsTrading: true,
      supportsMargin: true,
      supportsLeverage: true,
      supportsShortSelling: true,
      supportedOrderTypes: ['market', 'limit', 'stop', 'stop-limit', 'trailing-stop'],
      supportedDurations: [
        { type: 'day', label: 'DAY' },
        { type: 'gtc', label: 'GTC' },
      ],
      supportsMarketBrackets: true,
      supportsMultipleExitLevels: true,
      supportsUnpairedExitLevels: true,
      supportsStopLoss: true,
      supportsTrailingStop: true,
      maxExitLevels: 10,
    },
    customFields: {
      provider: MOCK_PROVIDER,
      synthetic: true,
      availableFunds: STARTING_CASH * 4,
      dailyPnl: 0,
    },
  }
}

function mockFeatures(): TradingFeatureSet {
  return {
    supportsOrders: true,
    supportsPositions: true,
    supportsOrderHistory: true,
    supportsExecutions: true,
    supportsOrderPreview: true,
    supportsModifyOrderPreview: true,
    supportsReversePosition: true,
    supportsBrackets: true,
    supportsNativeStopLimit: true,
    supportsAccountPanel: true,
    optionChain: { supportsChains: true, supportsSnapshotQuotes: true },
  }
}

function inBulkScope(
  record: {
    accountId?: string
    symbol: SdkSymbolInfo
    optionLegs?: Array<{ contract: TradingOptionContract }>
    optionContract?: TradingOptionContract
  },
  options: TradingBulkActionOptions | undefined,
): boolean {
  return (
    (options?.accountId === undefined || record.accountId === options.accountId) &&
    (options?.symbol === undefined ||
      instrumentKey(
        record.optionContract
          ? exactOptionSymbol(record.optionContract)
          : record.optionLegs?.[0]
            ? exactOptionSymbol(record.optionLegs[0].contract)
            : record.symbol,
      ) === instrumentKey(options.symbol))
  )
}

function signedPosition(position: TradingPosition): number {
  return position.side === 'short' ? -position.quantity : position.quantity
}

function instrumentKey(symbol: SdkSymbolInfo): string {
  return `${symbol.provider ?? ''}:${symbol.canonicalSymbol ?? symbol.brokerSymbol ?? symbol.ticker}`
}

function optionKey(contract: TradingOptionContract): string {
  return (
    contract.symbol ??
    `${contract.underlying}-${contract.expiration}-${contract.right}-${contract.strike}`
  )
}

function intervalMilliseconds(interval: ChartInterval): number {
  const match = /^(\d+)([smHDWM])$/u.exec(interval)
  if (!match) return 60_000
  const amount = Number(match[1])
  const unit = match[2]
  const multiplier =
    unit === 's'
      ? 1_000
      : unit === 'm'
        ? 60_000
        : unit === 'H'
          ? 3_600_000
          : unit === 'D'
            ? 86_400_000
            : unit === 'W'
              ? 604_800_000
              : 2_592_000_000
  return amount * multiplier
}

function futureExpiration(timestamp: number): string {
  const date = new Date(timestamp + 35 * 86_400_000)
  return date.toISOString().slice(0, 10)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function money(value: number): number {
  return Math.round(value * 100) / 100
}

function mockQuote(
  symbol: SdkSymbolInfo,
  now: () => number,
  optionContracts: Map<string, TradingOptionContract>,
  overrides: Map<string, SyntheticQuoteUpdate>,
): Quote {
  const option =
    symbol.type === 'option' ? optionContracts.get(symbol.brokerSymbol ?? '') : undefined
  if (
    symbol.type === 'option' &&
    (!option ||
      symbol.provider !== MOCK_PROVIDER ||
      symbol.canonicalSymbol !== `mock-option:${String(option.brokerContractId)}`)
  ) {
    return {
      symbol,
      status: 'unavailable',
      timestamp: now(),
      metadata: { provider: MOCK_PROVIDER, synthetic: true },
    }
  }
  const base = option ? BASE_PRICES[option.underlying] : undefined
  const intrinsic =
    option && base !== undefined
      ? option.right === 'call'
        ? Math.max(0, base - option.strike)
        : Math.max(0, option.strike - base)
      : undefined
  const last =
    option && base !== undefined && intrinsic !== undefined
      ? round(Math.max(0.5, intrinsic + 2.5 - Math.abs(base - option.strike) * 0.05))
      : (BASE_PRICES[symbol.ticker] ?? 100)
  const halfSpread = option ? 0.01 : 0.05
  const override = overrides.get(instrumentKey(symbol))
  const quotedLast = override?.last ?? last
  return {
    symbol,
    last: quotedLast,
    bid: override?.bid ?? round(last - halfSpread),
    ask: override?.ask ?? round(last + halfSpread),
    spread: override ? override.ask - override.bid : halfSpread * 2,
    change: quotedLast - (last - 1.25),
    changePercent: ((quotedLast - (last - 1.25)) / (last - 1.25)) * 100,
    open: last - 1.1,
    high: Math.max(last + 1.4, quotedLast),
    low: Math.min(last - 1.8, quotedLast),
    previousClose: last - 1.25,
    volume: 2_450_000,
    timestamp: now(),
    status: 'ok',
    metadata: { provider: MOCK_PROVIDER, synthetic: true },
  }
}
