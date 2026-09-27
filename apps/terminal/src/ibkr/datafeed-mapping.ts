import type {
  ChartInterval,
  Quote,
  SdkMarketDepth,
  SessionWindow,
  SymbolInfo,
} from '@tradescript/pro/sdk'
import { SdkError } from '@tradescript/pro/sdk'
import type {
  BackendMarketDepth,
  BackendMarketSymbol,
  BackendQuote,
  BackendSessionWindow,
} from './datafeed-types.js'
import { TOP_OF_BOOK_DEPTH_MAX_AGE_MS } from './datafeed-types.js'
import { withoutUndefined } from './defined-fields.js'

export function toSessionWindow(window: BackendSessionWindow): SessionWindow {
  return withoutUndefined<SessionWindow>({
    opensAt: window.opensAt,
    closesAt: window.closesAt,
    state: window.state,
  })
}

export function sessionRequestKey(symbol: SymbolInfo): string {
  return JSON.stringify([
    symbol.ticker,
    symbol.brokerSymbol,
    symbol.canonicalSymbol,
    symbol.exchange,
    symbol.listedExchange,
    symbol.type,
    symbol.currency,
  ])
}

export function optionContractCode(contract: import('./types').BackendOptionContract): string {
  return String(
    contract.brokerContractId ??
      [
        contract.underlying,
        contract.expiration,
        contract.strike,
        contract.right,
        contract.exchange,
      ].join(':'),
  )
}

export function sharedQuoteMetadata(symbols: Array<string | SymbolInfo>): {
  exchange?: string | undefined
  primaryExchange?: string | undefined
  currency?: string | undefined
  assetClass?: string | undefined
} {
  const richSymbols = symbols.filter((symbol): symbol is SymbolInfo => typeof symbol !== 'string')
  if (richSymbols.length !== symbols.length || richSymbols.length === 0)
    return withoutUndefined<{
      exchange?: string | undefined
      primaryExchange?: string | undefined
      currency?: string | undefined
      assetClass?: string | undefined
    }>({})
  return withoutUndefined<{
    exchange?: string | undefined
    primaryExchange?: string | undefined
    currency?: string | undefined
    assetClass?: string | undefined
  }>({
    exchange: sharedValue(richSymbols.map((symbol) => symbol.exchange)),
    primaryExchange: sharedValue(richSymbols.map((symbol) => symbol.listedExchange)),
    currency: sharedValue(richSymbols.map((symbol) => symbol.currency)),
    assetClass: sharedValue(richSymbols.map((symbol) => symbol.type)),
  })
}

function sharedValue(values: Array<string | undefined>): string | undefined {
  const defined = values.filter((value): value is string => Boolean(value))
  if (defined.length !== values.length || defined.length === 0) return undefined
  const [first] = defined
  return defined.every((value) => value === first) ? first : undefined
}

export function toQuote(quote: BackendQuote): Quote {
  const symbol = toSymbolInfo({
    ticker: quote.symbol.symbol,
    canonicalSymbol: quote.symbol.canonicalSymbol,
    exchange: quote.symbol.exchange,
    type: quote.symbol.assetClass as BackendMarketSymbol['type'],
    currency: quote.symbol.currency,
  })
  const diagnosticReason = quote.unavailableReason?.trim()
  return withoutUndefined<Quote>({
    symbol,
    bid: quote.bid,
    ask: quote.ask,
    last: quote.last,
    change: quote.change,
    changePercent: quote.changePercent,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    previousClose: quote.previousClose,
    volume: quote.volume,
    timestamp: Date.parse(quote.timestamp),
    status: quote.status,
    ...(diagnosticReason
      ? {
          diagnostic: {
            provider: 'IBKR',
            reason: diagnosticReason,
            ...(quote.ibkrErrorCode === undefined ? {} : { code: quote.ibkrErrorCode }),
          },
        }
      : {}),
    metadata: {
      provider: 'IBKR',
      ...(quote.marketDataType ? { marketDataType: quote.marketDataType } : {}),
      ...(quote.mark === undefined
        ? {}
        : { referencePrice: quote.mark, referencePriceKind: 'mark' }),
      ...(quote.unavailableReason ? { unavailableReason: quote.unavailableReason } : {}),
      ...(quote.ibkrErrorCode === undefined ? {} : { ibkrErrorCode: quote.ibkrErrorCode }),
    },
  })
}

export function toMarketDepth(
  depth: BackendMarketDepth,
  requestedSymbol: SymbolInfo,
  levels?: number,
  quote?: BackendQuote,
  now = Date.now(),
): SdkMarketDepth {
  const requestedBrokerSymbol = requestedSymbol.brokerSymbol ?? requestedSymbol.ticker
  if (depth.symbol.symbol !== requestedBrokerSymbol) {
    throw new SdkError(
      'datafeed.request-failed',
      'IBKR market depth belongs to a different symbol.',
      {
        requestedSymbol: requestedBrokerSymbol,
        receivedSymbol: depth.symbol.symbol,
      },
    )
  }
  const limit = levels && levels > 0 ? levels : undefined
  const hasProviderDepth = depth.bids.length > 0 || depth.asks.length > 0
  const quoteTimestamp = quote ? Date.parse(quote.timestamp) : Number.NaN
  const useTopOfBook =
    !hasProviderDepth &&
    Boolean(depth.diagnostic) &&
    quote !== undefined &&
    quote.status !== 'unavailable' &&
    backendQuoteMatches(quote, requestedSymbol) &&
    Number.isFinite(quoteTimestamp)
  const positive = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value > 0
  const bidTimestamp = quote ? Date.parse(quote.bidUpdatedAt ?? quote.timestamp) : Number.NaN
  const askTimestamp = quote ? Date.parse(quote.askUpdatedAt ?? quote.timestamp) : Number.NaN
  const fresh = (timestamp: number) =>
    Number.isFinite(timestamp) && timestamp <= now && now - timestamp < TOP_OF_BOOK_DEPTH_MAX_AGE_MS
  const topBids =
    useTopOfBook && fresh(bidTimestamp) && positive(quote.bid) && positive(quote.bidSize)
      ? [{ price: quote.bid as number, size: quote.bidSize as number, marketMaker: 'IBKR TOP' }]
      : []
  const topAsks =
    useTopOfBook && fresh(askTimestamp) && positive(quote.ask) && positive(quote.askSize)
      ? [{ price: quote.ask as number, size: quote.askSize as number, marketMaker: 'IBKR TOP' }]
      : []
  const usingTopOfBook = topBids.length > 0 || topAsks.length > 0
  const topTimestamps = [
    ...(topBids.length ? [bidTimestamp] : []),
    ...(topAsks.length ? [askTimestamp] : []),
  ]
  const bids = usingTopOfBook ? topBids : depth.bids
  const asks = usingTopOfBook ? topAsks : depth.asks
  return withoutUndefined<SdkMarketDepth>({
    symbol: requestedSymbol,
    bids: bids.slice(0, limit).map((level) => ({
      price: level.price,
      size: level.size,
      exchange: level.marketMaker,
      ...(usingTopOfBook ? { tier: 'Top of book' } : {}),
    })),
    asks: asks.slice(0, limit).map((level) => ({
      price: level.price,
      size: level.size,
      exchange: level.marketMaker,
      ...(usingTopOfBook ? { tier: 'Top of book' } : {}),
    })),
    timestamp: usingTopOfBook ? Math.max(...topTimestamps) : Date.parse(depth.updatedAt),
    diagnostic: depth.diagnostic
      ? {
          provider: 'IBKR',
          code: depth.diagnostic.code,
          reason: depth.diagnostic.message,
        }
      : undefined,
    metadata: {
      ...(depth.diagnostic ? { depthDiagnostic: depth.diagnostic } : {}),
      ...(usingTopOfBook
        ? {
            depthSource: 'top-of-book',
            depthCoverage: 'Best bid and ask only; Level II unavailable.',
            depthExpiresAt: Math.min(...topTimestamps) + TOP_OF_BOOK_DEPTH_MAX_AGE_MS,
            quoteStatus: quote?.status,
          }
        : {}),
    },
  })
}

export function backendQuoteMatches(quote: BackendQuote, symbol: SymbolInfo): boolean {
  return (
    quote.symbol.symbol === (symbol.brokerSymbol ?? symbol.ticker) &&
    (!symbol.exchange || quote.symbol.exchange === symbol.exchange) &&
    (!symbol.currency || quote.symbol.currency === symbol.currency) &&
    (!symbol.type || quote.symbol.assetClass === symbol.type)
  )
}

export function symbolKey(symbol: string | SymbolInfo): string {
  if (typeof symbol === 'string') return symbol.toUpperCase()
  return (symbol.brokerSymbol ?? symbol.ticker).toUpperCase()
}

export function toSymbolInfo(symbol: BackendMarketSymbol): SymbolInfo {
  const minTick = symbol.minTick
  const tickScale = minTick ? tickScaleFromTick(minTick) : undefined
  return withoutUndefined<SymbolInfo>({
    ...(symbol.prediction ? { instrument: symbol.prediction } : {}),
    ticker: symbol.ticker,
    exchange: symbol.exchange,
    listedExchange: symbol.primaryExchange,
    canonicalSymbol: symbol.canonicalSymbol ?? symbol.ticker,
    brokerSymbol: symbol.brokerSymbol ?? symbol.ticker,
    name: symbol.name,
    description: symbol.description,
    type: symbol.type,
    currency: symbol.currency,
    pricePrecision: minTick ? precisionFromTick(minTick) : undefined,
    tickSize: minTick,
    priceFormat: priceFormatFromIncrements(symbol.priceIncrements, minTick),
    pricescale: tickScale?.pricescale,
    minMove: tickScale?.minMove,
  })
}

function priceFormatFromIncrements(
  increments: BackendMarketSymbol['priceIncrements'],
  fallback: number | undefined,
): SymbolInfo['priceFormat'] | undefined {
  const bands = increments?.filter(
    (band) => Number.isFinite(band.lowEdge) && band.lowEdge >= 0 && band.increment > 0,
  )
  const base = bands?.[0]?.increment ?? fallback
  const scale = base ? tickScaleFromTick(base) : undefined
  if (!scale) return undefined
  return {
    priceScale: scale.pricescale,
    minMove: scale.minMove,
    ...(bands && bands.length > 1
      ? {
          variableTickSize: bands
            .flatMap((band, index) =>
              index === 0
                ? [String(band.increment)]
                : [String(band.lowEdge), String(band.increment)],
            )
            .join(' '),
        }
      : {}),
  }
}

function precisionFromTick(tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return 2
  const text = tick.toString()
  const decimal = text.indexOf('.')
  return decimal === -1 ? 0 : Math.min(8, text.length - decimal - 1)
}

function tickScaleFromTick(tick: number): { pricescale: number; minMove: number } | undefined {
  if (!Number.isFinite(tick) || tick <= 0) return undefined
  const precision = precisionFromTick(tick)
  const pricescale = 10 ** precision
  return withoutUndefined<{ pricescale: number; minMove: number } | undefined>({
    pricescale,
    minMove: Math.max(1, Math.round(tick * pricescale)),
  })
}

export function intervalToMs(interval: ChartInterval): number {
  const match = /^(\d+)(s|m|H|D|W|M)$/.exec(interval)
  const value = Number(match?.[1] ?? 1) || 1
  const unit = match?.[2] ?? 'm'
  if (unit === 's') return value * 1000
  if (unit === 'H') return value * 60 * 60 * 1000
  if (unit === 'D') return value * 24 * 60 * 60 * 1000
  if (unit === 'W') return value * 7 * 24 * 60 * 60 * 1000
  if (unit === 'M') return value * 30 * 24 * 60 * 60 * 1000
  return value * 60 * 1000
}
