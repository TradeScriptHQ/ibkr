import type {
  Bar,
  BarHistoryRequest,
  BarHistoryResult,
  ChartInterval,
  DepthCallback,
  DepthRequest,
  DepthSubscription,
  MarketDataFeed,
  MarketDataFeedConfig,
  OptionQuotesCallback,
  OptionQuotesSubscription,
  OptionSeriesSnapshot,
  Quote,
  QuoteCallback,
  QuoteRequest,
  QuoteSubscription,
  RealTimeBarCallback,
  RealTimeBarSubscription,
  SdkMarketDepth,
  SessionAggregationCalendarRequest,
  SessionInfo,
  SymbolInfo,
  SymbolSearchRequest,
  SymbolSearchResult,
  TimeAndSalesCallback,
  TimeAndSalesEntry,
  TimeAndSalesRequest,
  TimeAndSalesSubscription,
  Unsubscribe,
} from '@tradescript/pro/sdk'
import { SdkError } from '@tradescript/pro/sdk'
import {
  backendQuoteMatches,
  intervalToMs,
  sessionRequestKey,
  symbolKey,
  toMarketDepth,
  toQuote,
  toSymbolInfo,
} from './datafeed-mapping.js'
import {
  diagnosticMessage,
  get,
  getBackendQuotes,
  getOptionSeries,
  getQuotes,
  getTimeAndSales,
  loadBars,
  optionSeriesParams,
  resolveIbkrSessionCalendar,
  resolveIbkrSessionInfo,
  toOptionSeriesSnapshot,
} from './datafeed-requests.js'
import type {
  BackendEvent,
  BackendMarketDepth,
  BackendMarketSymbol,
  BackendQuote,
  BackendSymbolSearchResult,
} from './datafeed-types.js'
import { withoutUndefined } from './defined-fields.js'
import { withDepthQuote } from './depth-quote.js'
import { loadInstrumentDetails } from './fundamentals.js'
import type { BackendOptionChainResult } from './types.js'

export interface IbkrMarketDatafeedOptions {
  baseUrl?: string | undefined
  pollMs?: number | undefined
}

const SUPPORTED_INTERVALS: ChartInterval[] = [
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
]

export function createIbkrMarketDatafeed(options: IbkrMarketDatafeedOptions = {}): MarketDataFeed {
  const baseUrl = (options.baseUrl ?? 'http://localhost:8765').replace(/\/+$/, '')
  const pollMs = options.pollMs ?? 10000
  // Widgets share the feed's stream so long-lived HTTP connections cannot starve asset requests.
  let eventSource: EventSource | undefined
  let latestDepth: BackendMarketDepth | undefined
  let eventSubscriberCount = 0
  const subscribeEvents = (
    eventNames: string[],
    listener: (event: MessageEvent<string>) => void,
  ): Unsubscribe => {
    if (!eventSource) {
      eventSource = new EventSource(`${baseUrl}/events`)
      const rememberDepth = (event: MessageEvent<string>) => {
        const payload = JSON.parse(event.data) as BackendEvent
        if (payload.type === 'state') latestDepth = payload.state.marketDepth
        if (payload.type === 'market-depth') latestDepth = payload.marketDepth
      }
      eventSource.addEventListener('state', rememberDepth)
      eventSource.addEventListener('market-depth', rememberDepth)
    }
    const source = eventSource
    eventSubscriberCount += 1
    for (const name of eventNames) source.addEventListener(name, listener)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      for (const name of eventNames) source.removeEventListener(name, listener)
      eventSubscriberCount -= 1
      if (eventSubscriberCount === 0) {
        source.close()
        eventSource = undefined
        latestDepth = undefined
      }
    }
  }
  const sessionCache = new Map<string, { expiresAt: number; value: SessionInfo }>()
  const sessionInflight = new Map<string, Promise<SessionInfo>>()
  const resolveSessionCached = (symbol: SymbolInfo): Promise<SessionInfo> => {
    const key = sessionRequestKey(symbol)
    const cached = sessionCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
    const existing = sessionInflight.get(key)
    if (existing) return existing
    const request = resolveIbkrSessionInfo(baseUrl, symbol)
      .then((value) => {
        sessionCache.set(key, { expiresAt: Date.now() + 30_000, value })
        return value
      })
      .finally(() => {
        sessionInflight.delete(key)
      })
    sessionInflight.set(key, request)
    return request
  }

  return {
    onReady(): MarketDataFeedConfig {
      return {
        supportsSearch: true,
        symbolSearch: {
          assetTypes: [
            { value: '', label: 'All' },
            { value: 'stock', label: 'Stocks' },
            { value: 'forex', label: 'Forex' },
            { value: 'crypto', label: 'Crypto' },
            {
              value: 'futures',
              label: 'Futures',
              requiresExchange: true,
              exchanges: ['CME', 'CBOT', 'NYMEX', 'COMEX', 'EUREX'].map((value) => ({
                value,
                label: value,
              })),
            },
            {
              value: 'index',
              label: 'Indices',
              requiresExchange: true,
              exchanges: [{ value: 'CBOE', label: 'CBOE' }],
            },
            {
              value: 'fund',
              label: 'Mutual funds',
              requiresExchange: true,
              exchanges: [{ value: 'FUNDSERV', label: 'FUNDSERV' }],
            },
            {
              value: 'bond',
              label: 'Bonds',
              requiresExchange: true,
              exchanges: [{ value: 'SMART', label: 'SMART' }],
            },
            {
              value: 'warrant',
              label: 'Warrants',
              requiresExchange: true,
              exchanges: [{ value: 'FWB', label: 'FWB' }],
            },
            {
              value: 'commodity',
              label: 'Spot metals / commodities',
              requiresExchange: true,
              exchanges: [{ value: 'SMART', label: 'SMART' }],
            },
            {
              value: 'cfd',
              label: 'CFDs',
              requiresExchange: true,
              exchanges: [{ value: 'SMART', label: 'SMART' }],
            },
            {
              value: 'event-contract',
              label: 'Forecast contracts',
              requiresExchange: true,
              exchanges: [{ value: 'FORECASTX', label: 'FORECASTX' }],
            },
          ],
          exchanges: [
            { value: '', label: 'All exchanges' },
            ...[
              'SMART',
              'CME',
              'CBOT',
              'NYMEX',
              'COMEX',
              'EUREX',
              'CBOE',
              'FUNDSERV',
              'FWB',
              'FORECASTX',
            ].map((value) => ({ value, label: value })),
          ],
        },
        supportsRealTime: true,
        supportsServerTime: true,
        supportsQuotes: true,
        supportsDepth: true,
        supportsTimeAndSales: true,
        supportsSessionInfo: true,
        supportsSessionCalendar: true,
        supportsOptionContracts: true,
        supportsOptionQuotes: true,
        supportedIntervals: SUPPORTED_INTERVALS,
      }
    },

    async searchSymbols(request: SymbolSearchRequest): Promise<SymbolSearchResult[]> {
      const params = new URLSearchParams({
        query: request.searchText,
        limit: String(request.limit ?? 10),
      })
      if (request.assetType) params.set('assetClass', request.assetType)
      if (request.exchange) params.set('exchange', request.exchange)
      const results = await get<BackendSymbolSearchResult[]>(
        baseUrl,
        `/symbols/search?${params.toString()}`,
      )
      return results.map((result) =>
        withoutUndefined<SymbolSearchResult>({
          symbol: toSymbolInfo(result.symbol),
          displayName: result.displayName,
          description: result.description,
          provider: result.provider ?? 'IBKR',
        }),
      )
    },

    async resolveSymbol(symbol: string | SymbolInfo): Promise<SymbolInfo> {
      const query = typeof symbol === 'string' ? symbol : (symbol.brokerSymbol ?? symbol.ticker)
      const params = new URLSearchParams({ symbol: query })
      if (typeof symbol !== 'string') {
        if (symbol.exchange) params.set('exchange', symbol.exchange)
        if (symbol.listedExchange) params.set('primaryExchange', symbol.listedExchange)
        if (symbol.currency) params.set('currency', symbol.currency)
        if (symbol.type) params.set('assetClass', symbol.type)
      }
      const resolved = toSymbolInfo(
        await get<BackendMarketSymbol>(baseUrl, `/symbols/resolve?${params.toString()}`),
      )
      return typeof symbol === 'string' ? resolved : { ...symbol, ...resolved }
    },

    getInstrumentDetails(request) {
      return loadInstrumentDetails(baseUrl, request)
    },

    async loadBars(
      symbol: SymbolInfo,
      interval: ChartInterval,
      request: BarHistoryRequest,
    ): Promise<BarHistoryResult> {
      return loadBars(baseUrl, symbol, interval, request)
    },

    async getServerTime(): Promise<number> {
      const payload = await get<{ time: number }>(baseUrl, '/time')
      return Number.isFinite(payload.time) ? payload.time : Date.now()
    },

    async resolveSessionInfo(request) {
      return resolveSessionCached(request.symbol)
    },

    subscribeSessionInfo(subscription, callback): Unsubscribe {
      const emit = () => {
        void resolveSessionCached(subscription.symbol).then(callback, () => undefined)
      }
      emit()
      const timer = window.setInterval(emit, 60_000)
      return () => window.clearInterval(timer)
    },

    async resolveSessionCalendar(request: SessionAggregationCalendarRequest) {
      return resolveIbkrSessionCalendar(baseUrl, request)
    },

    async getQuotes(request: QuoteRequest): Promise<Quote[]> {
      return getQuotes(baseUrl, request.symbols)
    },

    async getOptionContracts(request): Promise<OptionSeriesSnapshot> {
      return getOptionSeries(baseUrl, request.symbol, request.expiration).catch((error) => {
        console.error(`IBKR option catalog failed: ${diagnosticMessage(error)}`)
        throw error
      })
    },

    async getOptionQuotes(request): Promise<OptionSeriesSnapshot> {
      return getOptionSeries(baseUrl, request.symbol, request.expiration, request).catch(
        (error) => {
          console.error(`IBKR option quotes failed: ${diagnosticMessage(error)}`)
          throw error
        },
      )
    },

    subscribeOptionQuotes(
      subscription: OptionQuotesSubscription,
      callback: OptionQuotesCallback,
    ): Unsubscribe {
      const params = optionSeriesParams(subscription.symbol, subscription.expiration, subscription)
      const endpoint = `/options/chain/events?${params.toString()}`
      const source = new EventSource(`${baseUrl}${endpoint}`)
      let closed = false
      let streamLive = false
      let fallbackActive = false
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined
      const fallback = async () => {
        if (closed || streamLive) return
        fallbackActive = true
        try {
          const snapshot = await getOptionSeries(
            baseUrl,
            subscription.symbol,
            subscription.expiration,
            subscription,
          )
          if (!closed && !streamLive) callback(snapshot)
        } catch {
          // EventSource reconnect and the next bounded snapshot retry remain authoritative.
        } finally {
          if (!closed && !streamLive) fallbackTimer = setTimeout(fallback, 5000)
        }
      }
      const handle = (event: MessageEvent<string>) => {
        streamLive = true
        if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
        const chain = JSON.parse(event.data) as BackendOptionChainResult
        callback(toOptionSeriesSnapshot(chain, endpoint))
      }
      const handleError = () => {
        if (!closed && !streamLive && !fallbackActive) void fallback()
      }
      source.addEventListener('option-quotes', handle)
      source.addEventListener('error', handleError)
      return () => {
        closed = true
        if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
        source.removeEventListener('option-quotes', handle)
        source.removeEventListener('error', handleError)
        source.close()
      }
    },

    async getDepth(request: DepthRequest): Promise<SdkMarketDepth> {
      const symbol = request.symbol
      const params = new URLSearchParams({
        symbol: symbol.brokerSymbol ?? symbol.ticker,
        levels: String(request.levels ?? 20),
      })
      if (symbol.exchange) params.set('exchange', symbol.exchange)
      if (symbol.listedExchange) params.set('primaryExchange', symbol.listedExchange)
      if (symbol.currency) params.set('currency', symbol.currency)
      if (symbol.type) params.set('assetClass', symbol.type)
      const [marketDepth, quotes] = await Promise.all([
        get<BackendMarketDepth | undefined>(baseUrl, `/depth?${params.toString()}`),
        getBackendQuotes(baseUrl, [symbol]),
      ])
      if (!marketDepth) {
        throw new SdkError(
          'datafeed.request-failed',
          'IBKR did not return a market-depth snapshot.',
          {
            symbol: request.symbol.ticker,
          },
        )
      }
      return toMarketDepth(marketDepth, request.symbol, request.levels, quotes[0])
    },

    subscribeDepth(subscription: DepthSubscription, callback: DepthCallback): Unsubscribe {
      let closed = false
      let currentDepth: BackendMarketDepth | undefined
      let currentQuote: BackendQuote | undefined
      let expiryTimer: ReturnType<typeof setTimeout> | undefined
      const publish = () => {
        if (closed || !currentDepth) return
        if (expiryTimer) clearTimeout(expiryTimer)
        const now = Date.now()
        const depth = toMarketDepth(
          currentDepth,
          subscription.symbol,
          subscription.levels,
          currentQuote,
          now,
        )
        callback(depth)
        if (depth.metadata?.depthSource !== 'top-of-book' || !currentQuote) return
        const remaining = Number(depth.metadata.depthExpiresAt) - now
        if (remaining > 0) expiryTimer = setTimeout(publish, remaining)
      }
      const handleMessage = (event: MessageEvent<string>) => {
        const payload = JSON.parse(event.data) as BackendEvent
        const depth =
          payload.type === 'market-depth'
            ? payload.marketDepth
            : payload.type === 'state'
              ? payload.state.marketDepth
              : undefined
        const quotes =
          payload.type === 'quotes'
            ? payload.quotes
            : payload.type === 'state'
              ? payload.state.quotes
              : undefined
        if (
          depth &&
          depth.symbol.symbol === (subscription.symbol.brokerSymbol ?? subscription.symbol.ticker)
        ) {
          currentDepth = depth
        }
        const quote = quotes?.find((candidate) =>
          backendQuoteMatches(candidate, subscription.symbol),
        )
        if (quote) currentQuote = quote
        if (currentDepth) publish()
      }
      void Promise.all([
        get<BackendMarketDepth>(
          baseUrl,
          `/depth?${new URLSearchParams({
            symbol: subscription.symbol.brokerSymbol ?? subscription.symbol.ticker,
            levels: String(subscription.levels ?? 20),
            ...(subscription.symbol.exchange ? { exchange: subscription.symbol.exchange } : {}),
            ...(subscription.symbol.listedExchange
              ? { primaryExchange: subscription.symbol.listedExchange }
              : {}),
            ...(subscription.symbol.currency ? { currency: subscription.symbol.currency } : {}),
            ...(subscription.symbol.type ? { assetClass: subscription.symbol.type } : {}),
          }).toString()}`,
        ),
        getBackendQuotes(baseUrl, [subscription.symbol]),
      ]).then(([depth, quotes]) => {
        if (closed) return
        currentDepth = depth
        currentQuote = quotes[0]
        publish()
      })
      const unsubscribe = subscribeEvents(['state', 'market-depth', 'quotes'], handleMessage)
      return () => {
        closed = true
        if (expiryTimer) clearTimeout(expiryTimer)
        unsubscribe()
      }
    },

    async getTimeAndSales(request: TimeAndSalesRequest): Promise<TimeAndSalesEntry[]> {
      return getTimeAndSales(baseUrl, request)
    },

    subscribeTimeAndSales(
      subscription: TimeAndSalesSubscription,
      callback: TimeAndSalesCallback,
    ): Unsubscribe {
      let disposed = false
      let lastSequence = 0
      let first = true
      const poll = async () => {
        try {
          const prints = await getTimeAndSales(baseUrl, subscription)
          const next = first
            ? prints
            : prints.filter((print) => (print.sequence ?? 0) > lastSequence)
          if (next.length > 0 && !disposed) {
            lastSequence = Math.max(lastSequence, ...next.map((print) => print.sequence ?? 0))
            callback({
              symbol: subscription.symbol,
              prints: next,
              snapshot: first,
            })
          }
          first = false
        } finally {
          if (!disposed) window.setTimeout(poll, 750)
        }
      }
      void poll()
      return () => {
        disposed = true
      }
    },

    subscribeQuotes(subscription: QuoteSubscription, callback: QuoteCallback): Unsubscribe {
      let closed = false
      let rawQuotes: Quote[] = []
      let expiryTimer: ReturnType<typeof setTimeout> | undefined
      const publish = () => {
        if (closed) return
        if (expiryTimer) clearTimeout(expiryTimer)
        const now = Date.now()
        const quotes = rawQuotes.map((quote) => withDepthQuote(quote, latestDepth, now))
        callback(quotes)
        const expiries = quotes
          .filter((quote) => quote.bidAskSource?.expiresAt !== undefined)
          .map((quote) => Number(quote.bidAskSource?.expiresAt) - now)
        if (expiries.length) expiryTimer = setTimeout(publish, Math.max(1, Math.min(...expiries)))
      }
      const symbolKeys = new Set(subscription.symbols.map(symbolKey))
      const requestedSymbols = new Map(
        subscription.symbols
          .filter((symbol): symbol is SymbolInfo => typeof symbol !== 'string')
          .map((symbol) => [symbol.ticker.toUpperCase(), symbol]),
      )
      void getQuotes(baseUrl, subscription.symbols)
        .then((quotes) => {
          if (!closed) {
            rawQuotes = quotes
            publish()
          }
        })
        .catch(() => undefined)

      const handleMessage = (event: MessageEvent<string>) => {
        const payload = JSON.parse(event.data) as BackendEvent
        const backendQuotes =
          payload.type === 'quotes' && 'quotes' in payload
            ? payload.quotes
            : payload.type === 'state' && 'state' in payload
              ? (payload.state.quotes ?? [])
              : []
        const quotes = backendQuotes
          .map((quote) => {
            const mapped = toQuote(quote)
            const requested = requestedSymbols.get(quote.symbol.symbol.toUpperCase())
            return requested ? { ...mapped, symbol: requested } : mapped
          })
          .filter((quote) => symbolKeys.has(symbolKey(quote.symbol)))
        if (quotes.length > 0) rawQuotes = quotes
        publish()
      }
      const unsubscribe = subscribeEvents(['state', 'quotes', 'market-depth'], handleMessage)
      return () => {
        closed = true
        if (expiryTimer) clearTimeout(expiryTimer)
        unsubscribe()
      }
    },

    subscribeRealTimeBars(
      subscription: RealTimeBarSubscription,
      callback: RealTimeBarCallback,
    ): Unsubscribe {
      let cancelled = false
      let lastTime = 0
      let latestBar: Bar | undefined
      let latestQuote: DevelopingQuote | undefined
      let timer: number | undefined
      const refreshMs =
        intervalToMs(subscription.interval) <= 30_000 ? Math.max(pollMs, 16_000) : pollMs

      // The order ticket consumes this same quote stream. Apply its latest trade only to the
      // unfinished matching bar; historical polling remains authoritative for completed candles.
      const publishQuote = (quote: Quote | undefined) => {
        if (cancelled || !quoteCanDevelopBar(quote)) return
        if (latestQuote && quote.timestamp < latestQuote.timestamp) return
        latestQuote = quote
        if (!latestBar) return
        const nextBar = developBarFromQuote(latestBar, quote, subscription.interval)
        if (!nextBar || sameBarValues(nextBar, latestBar)) return
        latestBar = nextBar
        lastTime = Math.max(lastTime, nextBar.time)
        callback(nextBar)
      }

      const publishBackendQuotes = (quotes: BackendQuote[]) => {
        const quote = quotes.find((candidate) =>
          backendQuoteMatches(candidate, subscription.symbol),
        )
        if (quote) publishQuote({ ...toQuote(quote), symbol: subscription.symbol })
      }

      void getQuotes(baseUrl, [subscription.symbol])
        .then(([quote]) => publishQuote(quote))
        .catch(() => undefined)

      const handleQuoteMessage = (event: MessageEvent<string>) => {
        const payload = JSON.parse(event.data) as BackendEvent
        if (payload.type === 'quotes' && 'quotes' in payload) publishBackendQuotes(payload.quotes)
        if (payload.type === 'state' && 'state' in payload) {
          publishBackendQuotes(payload.state.quotes ?? [])
        }
      }
      const unsubscribeQuotes = subscribeEvents(['state', 'quotes'], handleQuoteMessage)

      const poll = async () => {
        try {
          const result = await loadBars(baseUrl, subscription.symbol, subscription.interval, {
            startTime: Date.now() - intervalToMs(subscription.interval) * 10,
            endTime: Date.now(),
            barCount: 10,
            loadDirection: 'newer',
          })
          for (const nextBar of result.bars) {
            if (!cancelled && nextBar.time >= lastTime) {
              const developedBar = latestQuote
                ? (developBarFromQuote(nextBar, latestQuote, subscription.interval) ?? nextBar)
                : nextBar
              lastTime = developedBar.time
              latestBar = developedBar
              callback(developedBar)
            }
          }
        } catch (error) {
          console.warn(`IBKR realtime bars refresh failed: ${diagnosticMessage(error)}`)
        } finally {
          if (!cancelled) {
            timer = window.setTimeout(poll, refreshMs)
          }
        }
      }

      void poll()
      return () => {
        cancelled = true
        if (timer !== undefined) window.clearTimeout(timer)
        unsubscribeQuotes()
      }
    },
  }
}

type DevelopingQuote = Quote & { last: number; timestamp: number }

function quoteCanDevelopBar(quote: Quote | undefined): quote is DevelopingQuote {
  if (
    !quote ||
    quote.status === 'closed' ||
    quote.status === 'unavailable' ||
    !Number.isFinite(quote.timestamp) ||
    !Number.isFinite(quote.last) ||
    Number(quote.last) <= 0
  )
    return false
  const marketDataType = quote.metadata?.marketDataType
  return marketDataType !== 'frozen' && marketDataType !== 'delayed-frozen'
}

function developBarFromQuote(
  bar: Bar,
  quote: DevelopingQuote,
  interval: ChartInterval,
): Bar | undefined {
  const endTime = bar.time + intervalToMs(interval)
  if (quote.timestamp < bar.time || quote.timestamp >= endTime) return undefined
  return {
    ...bar,
    high: Math.max(bar.high, quote.last),
    low: Math.min(bar.low, quote.last),
    close: quote.last,
  }
}

function sameBarValues(left: Bar, right: Bar): boolean {
  return (
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume
  )
}
