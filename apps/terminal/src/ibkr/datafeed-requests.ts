import type {
  BarHistoryRequest,
  BarHistoryResult,
  ChartInterval,
  OptionSeriesSnapshot,
  Quote,
  SessionAggregationCalendar,
  SessionAggregationCalendarRequest,
  SessionInfo,
  SymbolInfo,
  TimeAndSalesEntry,
  TimeAndSalesRequest,
} from '@tradescript/pro/sdk'
import { isSdkError, SdkError } from '@tradescript/pro/sdk'
import { GatewayRequestError, gatewayRequest } from './broker-request.js'
import {
  optionContractCode,
  sharedQuoteMetadata,
  toQuote,
  toSessionWindow,
  toSymbolInfo,
} from './datafeed-mapping.js'
import type {
  BackendBarHistoryResult,
  BackendQuote,
  BackendSessionCalendar,
  BackendSessionInfo,
} from './datafeed-types.js'
import { withoutUndefined } from './defined-fields.js'
import type { BackendOptionChainResult } from './types'

export function diagnosticMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export async function getTimeAndSales(
  baseUrl: string,
  request: TimeAndSalesRequest,
): Promise<TimeAndSalesEntry[]> {
  const params = new URLSearchParams({
    symbol: request.symbol.brokerSymbol ?? request.symbol.ticker,
    limit: String(request.limit ?? 200),
  })
  if (request.symbol.exchange) params.set('exchange', request.symbol.exchange)
  if (request.symbol.listedExchange) {
    params.set('primaryExchange', request.symbol.listedExchange)
  }
  if (request.symbol.currency) params.set('currency', request.symbol.currency)
  if (request.symbol.type) params.set('assetClass', request.symbol.type)
  return get<TimeAndSalesEntry[]>(baseUrl, `/time-and-sales?${params.toString()}`)
}

export async function resolveIbkrSessionInfo(
  baseUrl: string,
  symbol: SymbolInfo,
): Promise<SessionInfo> {
  const params = new URLSearchParams({
    symbol: symbol.brokerSymbol ?? symbol.ticker,
  })
  if (symbol.exchange) params.set('exchange', symbol.exchange)
  if (symbol.listedExchange) params.set('primaryExchange', symbol.listedExchange)
  if (symbol.currency) params.set('currency', symbol.currency)
  if (symbol.type) params.set('assetClass', symbol.type)
  const sessionPath = `/sessions?${params.toString()}`
  const session = await get<BackendSessionInfo>(baseUrl, sessionPath).catch((cause) => {
    throw toSessionInfoError(cause, sessionPath)
  })
  return withoutUndefined<SessionInfo>({
    symbol: { ...symbol, ...toSymbolInfo(session.symbol) },
    timezone: session.timezone,
    currentState: session.currentState,
    asOf: session.asOf,
    upcoming: session.upcoming.map(toSessionWindow),
    note: session.note,
    metadata: {
      ...session.metadata,
      provider: session.source ?? 'IBKR',
    },
  })
}

export async function resolveIbkrSessionCalendar(
  baseUrl: string,
  request: SessionAggregationCalendarRequest,
): Promise<SessionAggregationCalendar> {
  const { symbol } = request
  const params = new URLSearchParams({
    symbol: symbol.brokerSymbol ?? symbol.ticker,
    startTime: String(request.startTime),
    endTime: String(request.endTime),
  })
  if (symbol.exchange) params.set('exchange', symbol.exchange)
  if (symbol.listedExchange) params.set('primaryExchange', symbol.listedExchange)
  if (symbol.currency) params.set('currency', symbol.currency)
  if (symbol.type) params.set('assetClass', symbol.type)
  const path = `/session-calendar?${params.toString()}`
  const calendar = await get<BackendSessionCalendar>(baseUrl, path).catch((cause) => {
    throw toSessionInfoError(cause, path)
  })
  return withoutUndefined<SessionAggregationCalendar>({
    symbol: { ...symbol, ...toSymbolInfo(calendar.symbol) },
    timezone: calendar.timezone,
    coverage: calendar.coverage,
    windows: calendar.windows.map(toSessionWindow),
    metadata: { provider: calendar.source ?? 'IBKR' },
  })
}

function toSessionInfoError(cause: unknown, path: string): SdkError {
  const message = cause instanceof Error ? cause.message : String(cause)
  const status =
    isSdkError(cause) && typeof cause.details?.status === 'number'
      ? cause.details.status
      : undefined
  const details = {
    ...(isSdkError(cause) ? cause.details : undefined),
    path,
  }
  if (status === 503) {
    return new SdkError('datafeed.session-disconnected', message, details)
  }
  if (status === 404) {
    return new SdkError('datafeed.session-unavailable', message, details)
  }
  return new SdkError('datafeed.session-error', message, details)
}

export async function getQuotes(
  baseUrl: string,
  symbols: Array<string | SymbolInfo>,
): Promise<Quote[]> {
  const backendQuotes = await getBackendQuotes(baseUrl, symbols)
  const requestedSymbols = new Map(
    symbols
      .filter((symbol): symbol is SymbolInfo => typeof symbol !== 'string')
      .map((symbol) => [(symbol.brokerSymbol ?? symbol.ticker).toUpperCase(), symbol]),
  )
  return backendQuotes.map((quote) => {
    const mapped = toQuote(quote)
    const requested = requestedSymbols.get(quote.symbol.symbol.toUpperCase())
    return requested ? { ...mapped, symbol: requested } : mapped
  })
}

export async function getBackendQuotes(
  baseUrl: string,
  symbols: Array<string | SymbolInfo>,
): Promise<BackendQuote[]> {
  const params = new URLSearchParams()
  const metadata = sharedQuoteMetadata(symbols)
  for (const symbol of symbols) {
    if (typeof symbol === 'string') {
      params.append('symbol', symbol)
    } else {
      params.append('symbol', symbol.brokerSymbol ?? symbol.ticker)
    }
  }
  if (metadata.exchange) params.set('exchange', metadata.exchange)
  if (metadata.primaryExchange) params.set('primaryExchange', metadata.primaryExchange)
  if (metadata.currency) params.set('currency', metadata.currency)
  if (metadata.assetClass) params.set('assetClass', metadata.assetClass)
  return get<BackendQuote[]>(baseUrl, `/quotes?${params.toString()}`)
}

export async function getOptionSeries(
  baseUrl: string,
  symbol: string | SymbolInfo,
  expiration?: string,
  window: {
    centerPrice?: number | undefined
    quoteWindowRows?: number | undefined
    minStrike?: number | undefined
    maxStrike?: number | undefined
  } = {},
): Promise<OptionSeriesSnapshot> {
  const params = optionSeriesParams(symbol, expiration, window)
  const path = `/options/chain?${params.toString()}`
  const chain = await get<BackendOptionChainResult>(baseUrl, path)
  return toOptionSeriesSnapshot(chain, path)
}

export function optionSeriesParams(
  symbol: string | SymbolInfo,
  expiration?: string,
  window: {
    centerPrice?: number | undefined
    quoteWindowRows?: number | undefined
    minStrike?: number | undefined
    maxStrike?: number | undefined
  } = {},
): URLSearchParams {
  const symbolInfo = typeof symbol === 'string' ? undefined : symbol
  const underlying = typeof symbol === 'string' ? symbol : (symbol.brokerSymbol ?? symbol.ticker)
  const params = new URLSearchParams({ underlying })
  if (expiration) {
    params.append('expiration', expiration)
    // Preserve the catalog so the SDK can apply its own strike-row selector.
    // The quote budget limits subscriptions, not the strikes users can browse.
    if (window.quoteWindowRows != null && Number.isFinite(window.quoteWindowRows)) {
      params.set('maxQuoteContracts', String(Math.max(1, Math.trunc(window.quoteWindowRows)) * 2))
    }
    for (const field of ['centerPrice', 'minStrike', 'maxStrike'] as const) {
      if (Number.isFinite(window[field])) params.set(field, String(window[field]))
    }
  }
  if (symbolInfo?.currency) params.set('currency', symbolInfo.currency)
  if (symbolInfo?.type) params.set('underlyingAssetClass', symbolInfo.type)
  if (symbolInfo?.exchange) params.set('underlyingExchange', symbolInfo.exchange)
  return params
}

export function toOptionSeriesSnapshot(
  chain: BackendOptionChainResult,
  endpoint: string,
): OptionSeriesSnapshot {
  const contracts = chain.expirations.flatMap((expirationGroup) =>
    expirationGroup.contracts.map((item) => {
      const quoteTimestamp = item.quoteTimestamp ? Date.parse(item.quoteTimestamp) : Number.NaN
      const referencePrice =
        item.last ??
        item.mark ??
        (item.bid !== undefined && item.ask !== undefined ? (item.bid + item.ask) / 2 : undefined)
      return {
        code: optionContractCode(item.contract),
        underlying_symbol: item.contract.underlying,
        bid_price: item.bid,
        ask_price: item.ask,
        last_price: item.last as number,
        theoretical_price: item.mark,
        expiration: Date.parse(`${expirationGroup.expiration}T00:00:00Z`),
        expiration_date: expirationGroup.expiration,
        type: item.contract.right === 'call' ? 'CALL' : 'PUT',
        strike_price: item.contract.strike,
        multiplier: item.contract.multiplier,
        price_step:
          priceIncrementAt(item.contract.priceIncrements, referencePrice) ??
          item.contract.priceStep,
        implied_volatility: item.impliedVolatility,
        delta: item.delta,
        gamma: item.gamma,
        theta: item.theta,
        vega: item.vega,
        open_interest: item.openInterest ?? 0,
        volume: item.volume,
        last_update: Number.isFinite(quoteTimestamp) ? quoteTimestamp : undefined,
        metrics: item.marketDataType ? { ibkrMarketDataType: item.marketDataType } : undefined,
        provider: 'IBKR',
      }
    }),
  )
  const now = Date.now()
  const quoteTimes = contracts
    .map((contract) => contract.last_update)
    .filter((value): value is number => Number.isFinite(value))
  const lastUpdate = quoteTimes.length ? Math.max(...quoteTimes) : 0
  const age = lastUpdate > 0 ? Math.max(0, now - lastUpdate) : Number.MAX_SAFE_INTEGER
  return withoutUndefined<OptionSeriesSnapshot>({
    symbol: chain.underlying,
    provider: 'IBKR',
    quote_timestamp: lastUpdate,
    expirations: chain.expirations.map((item) => item.expiration),
    strikes: [...new Set(contracts.map((contract) => contract.strike_price))].sort(
      (left, right) => left - right,
    ),
    contracts,
    quote_freshness: {
      last_update: lastUpdate,
      age_ms: age,
      status: lastUpdate === 0 ? 'unavailable' : age < 15_000 ? 'current' : 'stale',
    },
    field_provenance: {
      contracts: { source: 'IBKR', endpoint },
      quotes: { source: 'IBKR', endpoint },
    },
    field_availability: {
      bid_price: contracts.some((contract) => contract.bid_price !== undefined),
      ask_price: contracts.some((contract) => contract.ask_price !== undefined),
      last_price: contracts.some((contract) => Number.isFinite(contract.last_price)),
      theoretical_price: contracts.some((contract) => contract.theoretical_price !== undefined),
      implied_volatility: contracts.some((contract) => contract.implied_volatility !== undefined),
      open_interest: contracts.some((contract) => contract.open_interest > 0),
      volume: contracts.some((contract) => contract.volume !== undefined),
    },
  })
}

function priceIncrementAt(
  bands: Array<{ lowEdge: number; increment: number }> | undefined,
  price: number | undefined,
): number | undefined {
  if (!bands?.length) return undefined
  const finitePrice = price !== undefined && Number.isFinite(price) ? price : 0
  return bands
    .filter((band) => band.lowEdge <= finitePrice && band.increment > 0)
    .sort((left, right) => right.lowEdge - left.lowEdge)[0]?.increment
}

export async function loadBars(
  baseUrl: string,
  symbol: SymbolInfo,
  interval: ChartInterval,
  request: BarHistoryRequest,
): Promise<BarHistoryResult> {
  const params = new URLSearchParams({
    symbol: symbol.brokerSymbol ?? symbol.ticker,
    interval,
    startTime: String(request.startTime),
    endTime: String(request.endTime),
    barCount: String(request.barCount),
  })
  if (symbol.exchange) params.set('exchange', symbol.exchange)
  if (symbol.currency) params.set('currency', symbol.currency)
  if (symbol.type) params.set('assetClass', symbol.type)
  const result = await get<BackendBarHistoryResult>(baseUrl, `/bars?${params.toString()}`)
  return withoutUndefined<BarHistoryResult>({
    bars: result.bars,
    hasOlder: result.hasOlder,
    hasNewer: result.hasNewer,
    dataUnavailable: result.dataUnavailable,
  })
}

/** Adapt the shared HTTP error to the SDK's datafeed error contract. */
export async function get<T>(baseUrl: string, path: string): Promise<T> {
  try {
    return await gatewayRequest<T>(baseUrl, path)
  } catch (error) {
    if (!(error instanceof GatewayRequestError)) throw error
    throw new SdkError('datafeed.request-failed', `${error.message} (${error.status})`, {
      status: error.status,
      path: error.path,
    })
  }
}
