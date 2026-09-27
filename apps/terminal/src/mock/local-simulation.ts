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
  TradingEvent,
  TradingExecution,
  TradingFeatureSet,
  TradingOptionContract,
  TradingOrder,
  TradingOrderContext,
  TradingOrderDraft,
  TradingOrderPatch,
  TradingPosition,
  TradingState,
} from '@tradescript/pro/sdk'

export const MOCK_ACCOUNT_ID = 'MOCK-PAPER'
export const MOCK_PROVIDER = 'LOCAL-MOCK'

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
}

export interface LocalSimulationOptions {
  readonly now?: () => number
  readonly createDefaultAccountManagerInfo?: () => TradingAccountManagerInfo
}

export function createLocalSimulation(options: LocalSimulationOptions = {}): LocalSimulation {
  const now = options.now ?? Date.now
  return {
    broker: createMockBroker(now, options.createDefaultAccountManagerInfo),
    datafeed: createMockMarketDatafeed(now),
  }
}

function createMockMarketDatafeed(now: () => number): MarketDataFeed {
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
    BASE_PRICES[typeof selection === 'string' ? selection.toUpperCase() : selection.ticker] ?? 100
  const quoteFor = (selection: string | SdkSymbolInfo): Quote => {
    const symbol = resolve(selection)
    const last = priceFor(symbol)
    return {
      symbol,
      last,
      bid: last - 0.05,
      ask: last + 0.05,
      spread: 0.1,
      change: 1.25,
      changePercent: 0.63,
      open: last - 1.1,
      high: last + 1.4,
      low: last - 1.8,
      previousClose: last - 1.25,
      volume: 2_450_000,
      timestamp: now(),
      status: 'ok',
      metadata: { provider: MOCK_PROVIDER, synthetic: true },
    }
  }
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
          bid_price: round(mark - 0.05),
          ask_price: round(mark + 0.05),
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
  createDefaultAccountManagerInfo?: () => TradingAccountManagerInfo,
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
    account.balance = {
      ...account.balance,
      cash: money(cash),
      buyingPower: Math.max(0, equity * 4),
      equity,
      marginUsed: Math.max(0, Math.abs(marketValue) * 0.25),
      currency: 'USD',
    }
    account.customFields = {
      ...account.customFields,
      availableFunds: account.balance.buyingPower,
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
  const execute = (draft: TradingOrderDraft, context: TradingOrderContext, order: TradingOrder) => {
    const optionLeg = draft.optionLegs?.[0]
    const optionContract = optionLeg?.contract
    const side = optionLeg?.side ?? draft.side
    const quantity = optionLeg?.quantity ?? draft.quantity
    const multiplier = optionContract?.multiplier ?? 1
    const price =
      optionLeg?.price ??
      draft.price ??
      (side === 'buy' ? context.ask : context.bid) ??
      context.lastPrice
    if (!Number.isFinite(price) || Number(price) <= 0) {
      throw new Error('The local simulator requires an explicit positive execution price.')
    }
    const fillPrice = Number(price)
    const key = optionContract ? optionKey(optionContract) : instrumentKey(draft.symbol)
    const positionIndex = state.positions.findIndex((position) =>
      position.optionContract
        ? optionKey(position.optionContract) === key
        : instrumentKey(position.symbol) === key,
    )
    const existing = state.positions[positionIndex]
    const before = existing ? signedPosition(existing) : 0
    const delta = side === 'buy' ? quantity : -quantity
    const after = before + delta
    const positionId = existing?.id ?? `mock-position-${++sequence}`
    let realizedPnl = 0
    if (existing && Math.sign(before) !== Math.sign(delta)) {
      const closed = Math.min(Math.abs(before), Math.abs(delta))
      realizedPnl =
        (before > 0
          ? fillPrice - Number(existing?.averagePrice)
          : Number(existing?.averagePrice) - fillPrice) *
        closed *
        multiplier
    }
    if (after === 0) {
      if (positionIndex >= 0) state.positions.splice(positionIndex, 1)
    } else {
      const increasing = before === 0 || Math.sign(before) === Math.sign(delta)
      const averagePrice = increasing
        ? before === 0
          ? fillPrice
          : (Math.abs(before) * Number(existing?.averagePrice) + Math.abs(delta) * fillPrice) /
            Math.abs(after)
        : Math.sign(before) === Math.sign(after)
          ? Number(existing?.averagePrice)
          : fillPrice
      const positionSymbol = optionContract ? optionSymbol(optionContract) : draft.symbol
      const position: TradingPosition = {
        id: positionId,
        accountId: MOCK_ACCOUNT_ID,
        symbol: positionSymbol,
        ...(optionContract ? { optionContract } : {}),
        side: after > 0 ? 'long' : 'short',
        quantity: Math.abs(after),
        averagePrice,
        marketPrice: fillPrice,
        actionable: true,
        priceStep: 0.01,
        customFields: {
          marketValue: Math.abs(after) * fillPrice * multiplier,
          unrealizedPnl: 0,
          provider: MOCK_PROVIDER,
          synthetic: true,
        },
      }
      if (positionIndex >= 0) state.positions[positionIndex] = position
      else state.positions.push(position)
    }
    const execution: TradingExecution = {
      id: `mock-execution-${++sequence}`,
      accountId: MOCK_ACCOUNT_ID,
      orderId: order.id,
      positionId,
      symbol: optionContract ? optionSymbol(optionContract) : draft.symbol,
      ...(optionContract ? { optionContract } : {}),
      side,
      quantity,
      price: fillPrice,
      time: now(),
      commission: COMMISSION,
      currency: 'USD',
      metadata: { provider: MOCK_PROVIDER, synthetic: true, realizedPnl },
    }
    state.executions.push(execution)
    account.balance = {
      ...account.balance,
      cash: money(
        Number(account.balance?.cash ?? STARTING_CASH) -
          delta * fillPrice * multiplier -
          COMMISSION,
      ),
    }
    order.status = 'filled'
    order.filledQuantity = quantity
    order.remainingQuantity = 0
    order.averagePrice = fillPrice
    order.updatedAt = now()
  }

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
      return {
        symbol: context.symbol,
        ...(context.accountId ? { accountId: context.accountId } : {}),
        currency: 'USD',
        minQuantity: 1,
        maxQuantity: 10_000,
        quantityStep: 1,
        minNotional: 1,
        priceStep: 0.01,
        contractMultiplier: isOption ? 100 : 1,
        supportedOrderTypes: isOption
          ? ['market', 'limit']
          : ['market', 'limit', 'stop', 'stop-limit', 'trailing-stop'],
        supportedDurations: [
          { type: 'day', label: 'DAY' },
          { type: 'gtc', label: 'GTC' },
        ],
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
      return {
        contract: {
          ...request.contract,
          symbol: request.contract.symbol ?? optionKey(request.contract),
          brokerContractId: request.contract.brokerContractId ?? optionKey(request.contract),
          route: request.contract.route ?? 'LOCAL',
        },
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
      const unsupported = unsupportedDraftReason(draft)
      if (unsupported) return { accepted: false, message: unsupported, errors: [unsupported] }
      const price =
        draft.optionLegs?.[0]?.price ??
        draft.price ??
        context.ask ??
        context.bid ??
        context.lastPrice
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
    async previewModifyOrder(orderId) {
      return {
        accepted: state.orders.some((order) => order.id === orderId && order.status === 'working'),
        confirmId: `mock-modify-${++sequence}`,
      }
    },
    async placeOrder(draft, context) {
      const unsupported = unsupportedDraftReason(draft)
      if (unsupported) throw new Error(unsupported)
      const order: TradingOrder = {
        id: `mock-order-${++sequence}`,
        accountId: draft.accountId ?? context.accountId ?? MOCK_ACCOUNT_ID,
        symbol: draft.symbol,
        side: draft.side,
        type: draft.type,
        status: draft.type === 'market' ? 'filled' : 'working',
        quantity: draft.quantity,
        filledQuantity: 0,
        remainingQuantity: draft.quantity,
        ...(draft.price === undefined ? {} : { price: draft.price }),
        ...(draft.stopPrice === undefined ? {} : { stopPrice: draft.stopPrice }),
        ...(draft.duration === undefined ? {} : { duration: draft.duration }),
        ...(draft.optionLegs === undefined ? {} : { optionLegs: draft.optionLegs }),
        ...(draft.strategyLegs === undefined ? {} : { strategyLegs: draft.strategyLegs }),
        ...(draft.exits === undefined ? {} : { exits: draft.exits }),
        ...(draft.customFields === undefined ? {} : { customFields: draft.customFields }),
        createdAt: now(),
        updatedAt: now(),
        metadata: { provider: MOCK_PROVIDER, synthetic: true },
      }
      if (draft.type === 'market') execute(draft, context, order)
      state.orders.push(order)
      state.ordersHistory?.push(structuredClone(order))
      publish()
      return {
        accepted: true,
        status: order.status === 'filled' ? 'accepted' : 'submitted',
        order: structuredClone(order),
        message:
          order.status === 'filled'
            ? 'Filled by the synthetic local paper exchange.'
            : 'Working on the synthetic local paper exchange.',
      }
    },
    async modifyOrder(orderId, patch: TradingOrderPatch) {
      const order = state.orders.find((candidate) => candidate.id === orderId)
      if (order?.status !== 'working') throw new Error(`Working order not found: ${orderId}`)
      Object.assign(order, patch, { updatedAt: now() })
      syncOrderHistory(state, order)
      publish()
      return structuredClone(order)
    },
    async cancelOrder(orderId) {
      const order = state.orders.find((candidate) => candidate.id === orderId)
      if (order?.status !== 'working') throw new Error(`Working order not found: ${orderId}`)
      order.status = 'cancelled'
      order.updatedAt = now()
      order.remainingQuantity = 0
      syncOrderHistory(state, order)
      publish()
    },
    async cancelOrders(orderIds, context, financialOptions) {
      for (const orderId of orderIds) await broker.cancelOrder?.(orderId, context, financialOptions)
    },
    async cancelAllOrders() {
      let cancelled = 0
      for (const order of state.orders) {
        if (order.status !== 'working') continue
        order.status = 'cancelled'
        order.remainingQuantity = 0
        order.updatedAt = now()
        syncOrderHistory(state, order)
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
      const position = state.positions.find((candidate) => candidate.id === positionId)
      if (!position) throw new Error(`Position not found: ${positionId}`)
      const quantity = Math.min(options.quantity ?? position.quantity, position.quantity)
      await broker.placeOrder(
        {
          accountId: position.accountId,
          symbol: position.optionContract?.underlyingSymbolInfo ?? position.symbol,
          side: position.side === 'long' ? 'sell' : 'buy',
          type: 'market',
          quantity,
          ...(position.optionContract
            ? {
                optionLegs: [
                  {
                    contract: position.optionContract,
                    side: position.side === 'long' ? 'sell' : 'buy',
                    positionEffect: 'close',
                    quantity,
                    ratio: 1,
                    ...(context.lastPrice === undefined ? {} : { price: context.lastPrice }),
                  },
                ],
              }
            : {}),
        },
        context,
      )
    },
    async reversePosition(positionId, context) {
      const position = state.positions.find((candidate) => candidate.id === positionId)
      if (!position) throw new Error(`Position not found: ${positionId}`)
      await broker.placeOrder(
        {
          accountId: position.accountId,
          symbol: position.symbol,
          side: position.side === 'long' ? 'sell' : 'buy',
          type: 'market',
          quantity: position.quantity * 2,
        },
        context,
      )
    },
    async flattenPositions(contexts) {
      const positions = [...state.positions]
      for (const position of positions) {
        const context = contexts.find(
          (candidate) => instrumentKey(candidate.symbol) === instrumentKey(position.symbol),
        )
        if (!context) throw new Error(`No price context for ${position.symbol.ticker}`)
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
      maxExitLevels: 4,
    },
    customFields: { provider: MOCK_PROVIDER, synthetic: true, availableFunds: STARTING_CASH * 4 },
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

function unsupportedDraftReason(draft: TradingOrderDraft): string | undefined {
  if ((draft.optionLegs?.length ?? 0) > 1 || (draft.strategyLegs?.length ?? 0) > 0) {
    return 'The local simulator supports single-leg options only; use TWS paper for strategy execution.'
  }
  return undefined
}

function signedPosition(position: TradingPosition): number {
  return position.side === 'short' ? -position.quantity : position.quantity
}

function syncOrderHistory(state: TradingState, order: TradingOrder): void {
  if (state.ordersHistory === undefined) state.ordersHistory = []
  const history = state.ordersHistory
  const index = history.findIndex((candidate) => candidate.id === order.id)
  if (index >= 0) history[index] = structuredClone(order)
  else history.push(structuredClone(order))
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

function optionSymbol(contract: TradingOptionContract): SdkSymbolInfo {
  const ticker = optionKey(contract)
  return {
    ticker,
    canonicalSymbol: `mock-option:${ticker}`,
    brokerSymbol: ticker,
    exchange: contract.exchange ?? 'SMART',
    listedExchange: contract.exchange ?? 'SMART',
    currency: contract.currency ?? 'USD',
    type: 'option',
    provider: MOCK_PROVIDER,
  }
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
