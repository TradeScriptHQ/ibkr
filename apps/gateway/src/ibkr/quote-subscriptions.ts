import type { IBApi } from '@stoqey/ib'
import { isIbMarketDataWarning } from './broker-errors.js'
import {
  brokerSymbolKey,
  listingMarketDataExchange,
  normalizeBrokerSymbol,
  toIbQuoteContract,
} from './contracts.js'
import { marketQuoteHasPrice } from './market-data.js'
import { RequestError } from './request-error.js'
import type { BrokerStateStore } from './state-store.js'
import type { BrokerSymbol, MarketQuote } from './types.js'

const IB_TICK = {
  BID_SIZE: 0,
  BID: 1,
  ASK: 2,
  ASK_SIZE: 3,
  LAST: 4,
  LAST_SIZE: 5,
  HIGH: 6,
  LOW: 7,
  VOLUME: 8,
  CLOSE: 9,
  OPEN: 14,
  MARK_PRICE: 37,
  DELAYED_BID: 66,
  DELAYED_ASK: 67,
  DELAYED_LAST: 68,
  DELAYED_BID_SIZE: 69,
  DELAYED_ASK_SIZE: 70,
  DELAYED_LAST_SIZE: 71,
  DELAYED_VOLUME: 74,
  DELAYED_CLOSE: 75,
  DELAYED_OPEN: 76,
} as const

interface QuoteSubscription {
  reqId: number
  symbol: BrokerSymbol
  retryAttempt: number
  marketDataExchange?: string | undefined
  retryTimer?: ReturnType<typeof setTimeout> | undefined
  marketDataType?: number | undefined
  pendingBidPrice?: number | undefined
  pendingAskPrice?: number | undefined
}

/** Owns quote subscriptions, retry timers, tick decoding and reconnect recovery. */
export class QuoteSubscriptions {
  constructor(
    private readonly ib: IBApi,
    private readonly store: BrokerStateStore,
    private readonly allocateRequestId: () => number,
  ) {}
  restore(): void {
    for (const symbol of this.desiredQuoteSymbols.values()) this.ensureQuoteSubscription(symbol)
  }
  private readonly quoteSubscriptions = new Map<string, QuoteSubscription>()

  private readonly desiredQuoteSymbols = new Map<string, BrokerSymbol>()

  private readonly quoteRequestIds = new Map<number, string>()

  getQuotes(symbols: BrokerSymbol[], options: { maxAgeMs?: number } = {}): MarketQuote[] {
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    return symbols
      .map((symbol) => normalizeBrokerSymbol(symbol))
      .filter((symbol): symbol is BrokerSymbol => Boolean(symbol.symbol))
      .map((symbol) => {
        const previous = this.findQuote(symbol)
        const age = previous ? Date.now() - Date.parse(previous.timestamp) : 0
        const refresh =
          options.maxAgeMs !== undefined &&
          previous?.status === 'ok' &&
          (!Number.isFinite(age) || age >= options.maxAgeMs)
        const active = this.quoteSubscriptions.get(brokerSymbolKey(symbol))
        this.ensureQuoteSubscription(symbol, 0, active?.marketDataExchange, refresh)
        const existing = this.findQuote(symbol)
        if (existing) return existing
        const pending: MarketQuote = {
          symbol,
          timestamp: new Date().toISOString(),
          status: 'unavailable',
        }
        this.store.upsertQuote(pending)
        return pending
      })
  }

  private ensureQuoteSubscription(
    symbol: BrokerSymbol,
    retryAttempt = 0,
    marketDataExchange?: string,
    refresh = false,
  ): void {
    const key = brokerSymbolKey(symbol)
    symbol = {
      ...symbol,
      primaryExchange: symbol.primaryExchange ?? this.desiredQuoteSymbols.get(key)?.primaryExchange,
    }
    // Validate before retaining the request: rejected metadata must never leave a retry timer.
    const normalized = normalizeBrokerSymbol(symbol)
    const contract = toIbQuoteContract(normalized, marketDataExchange)
    this.desiredQuoteSymbols.set(key, symbol)
    const active = this.quoteSubscriptions.get(key)
    if (active) {
      // A later resolved symbol can supply the listing identity missing from an early watchlist read.
      if (
        !refresh &&
        (!symbol.primaryExchange || active.symbol.primaryExchange === symbol.primaryExchange)
      )
        return
      if (active.retryTimer) clearTimeout(active.retryTimer)
      this.quoteSubscriptions.delete(key)
      this.quoteRequestIds.delete(active.reqId)
      this.ib.cancelMktData(active.reqId)
    }
    const reqId = this.allocateRequestId()
    const subscription: QuoteSubscription = {
      reqId,
      symbol: normalized,
      retryAttempt,
      marketDataExchange,
    }
    this.quoteSubscriptions.set(key, subscription)
    this.quoteRequestIds.set(reqId, key)
    const previous = this.quoteForRequest(reqId)
    this.store.upsertQuote({
      symbol: normalized,
      timestamp: previous?.timestamp ?? new Date().toISOString(),
      status: 'unavailable',
      unavailableReason: previous?.unavailableReason ?? 'Waiting for IBKR quote prices.',
      ibkrErrorCode: previous?.ibkrErrorCode,
    })
    this.scheduleQuoteRetry(key, subscription)
    this.ib.reqMktData(reqId, contract, '', false, false)
    this.store.addDiagnostic(
      'info',
      `Requested quote stream for ${normalized.symbol} via ${contract.exchange ?? 'default'} (req ${reqId})`,
    )
  }

  private scheduleQuoteRetry(key: string, subscription: QuoteSubscription): void {
    if (subscription.retryTimer) return
    const delayMs = Math.min(60_000, 15_000 * 2 ** Math.min(subscription.retryAttempt, 2))
    subscription.retryTimer = setTimeout(() => {
      if (this.quoteSubscriptions.get(key) !== subscription) return
      const quote = this.quoteForRequest(subscription.reqId)
      const fallbackExchange =
        subscription.marketDataExchange ?? listingMarketDataExchange(subscription.symbol)
      const switchingToListingExchange =
        subscription.marketDataExchange === undefined && fallbackExchange !== undefined
      if (quote && quote.ibkrErrorCode === undefined) {
        this.store.upsertQuote({
          ...quote,
          status: 'unavailable',
          unavailableReason: switchingToListingExchange
            ? `IBKR returned no usable SMART prices for ${subscription.symbol.symbol} within ${delayMs / 1_000} seconds; retrying through ${fallbackExchange}.`
            : `IBKR returned no usable prices for ${subscription.symbol.symbol} within ${delayMs / 1_000} seconds; retrying the quote subscription.`,
        })
      }
      this.quoteSubscriptions.delete(key)
      this.quoteRequestIds.delete(subscription.reqId)
      this.ib.cancelMktData(subscription.reqId)
      if (this.store.getState().connectionStatus !== 'connected') return
      this.store.addDiagnostic(
        'warning',
        switchingToListingExchange
          ? `Retrying unavailable quote for ${subscription.symbol.symbol} through ${fallbackExchange} market data (req ${subscription.reqId})`
          : `Retrying unavailable quote for ${subscription.symbol.symbol} (req ${subscription.reqId})`,
      )
      this.ensureQuoteSubscription(
        subscription.symbol,
        subscription.retryAttempt + 1,
        fallbackExchange,
      )
    }, delayMs)
    subscription.retryTimer.unref?.()
  }

  clearQuoteSubscriptions(reason: string): void {
    for (const subscription of this.quoteSubscriptions.values()) {
      if (subscription.retryTimer) clearTimeout(subscription.retryTimer)
      const quote = this.quoteForRequest(subscription.reqId)
      this.store.upsertQuote({
        symbol: subscription.symbol,
        timestamp: quote?.timestamp ?? new Date().toISOString(),
        status: 'unavailable',
        unavailableReason: reason,
      })
    }
    this.quoteSubscriptions.clear()
    this.quoteRequestIds.clear()
  }

  handleQuoteError(error: Error, code?: number, reqId?: number, suffix = ''): boolean {
    if (reqId == null) return false
    const key = this.quoteRequestIds.get(reqId)
    const subscription = key == null ? undefined : this.quoteSubscriptions.get(key)
    if (!subscription || key == null) return false
    const quote = this.quoteForRequest(reqId)
    this.store.addDiagnostic(
      'warning',
      `Quote ${subscription.symbol.symbol}: ${error.message}${suffix}`,
    )
    // A delayed-data/partial-entitlement warning can precede valid ticks on the same stream.
    if (quote && marketQuoteHasPrice(quote) && isIbMarketDataWarning(code)) return true
    this.store.upsertQuote({
      symbol: subscription.symbol,
      timestamp: quote?.timestamp ?? new Date().toISOString(),
      status: 'unavailable',
      unavailableReason: error.message,
      ibkrErrorCode: code,
    })
    this.scheduleQuoteRetry(key, subscription)
    return true
  }

  findQuote(symbol: BrokerSymbol): MarketQuote | undefined {
    const key = brokerSymbolKey(symbol)
    const quotes = this.store.getState().quotes
    const exact = quotes.find((quote) => brokerSymbolKey(quote.symbol) === key)
    if (exact && marketQuoteHasPrice(exact)) return exact

    const normalized = normalizeBrokerSymbol(symbol)
    const fallback = quotes.find((quote) => {
      const candidate = normalizeBrokerSymbol(quote.symbol)
      return (
        candidate.symbol === normalized.symbol &&
        (candidate.assetClass ?? 'stock') === (normalized.assetClass ?? 'stock') &&
        (candidate.currency ?? '') === (normalized.currency ?? '') &&
        marketQuoteHasPrice(quote)
      )
    })
    return fallback ?? exact
  }

  handleTickPrice(reqId: number, field: number, value: number): void {
    if (!Number.isFinite(value)) return
    const quote = this.quoteForRequest(reqId)
    if (!quote) return
    const key = this.quoteRequestIds.get(reqId)
    const subscription = key == null ? undefined : this.quoteSubscriptions.get(key)
    if (!subscription) return
    const patch: Partial<MarketQuote> = {}
    const observedAt = new Date().toISOString()
    if (field === IB_TICK.BID || field === IB_TICK.DELAYED_BID) {
      if (value < 0) {
        // IBKR unavailable marker: clear immediately and await the size-0 confirmation.
        subscription.pendingBidPrice = value
        patch.bid = undefined
        patch.bidSize = undefined
        patch.bidUpdatedAt = undefined
      } else if (value === 0) {
        // Zero may be valid (with positive size) or unavailable (with size 0).
        // Do not publish it until the paired size tick resolves that ambiguity.
        subscription.pendingBidPrice = value
      } else {
        subscription.pendingBidPrice = undefined
        patch.bid = value
        patch.bidUpdatedAt = observedAt
      }
    }
    if (field === IB_TICK.ASK || field === IB_TICK.DELAYED_ASK) {
      if (value < 0) {
        subscription.pendingAskPrice = value
        patch.ask = undefined
        patch.askSize = undefined
        patch.askUpdatedAt = undefined
      } else if (value === 0) {
        subscription.pendingAskPrice = value
      } else {
        subscription.pendingAskPrice = undefined
        patch.ask = value
        patch.askUpdatedAt = observedAt
      }
    }
    if (field === IB_TICK.LAST || field === IB_TICK.DELAYED_LAST) {
      if (value <= 0) return
      patch.last = value
    }
    if (field === IB_TICK.MARK_PRICE) {
      if (value <= 0) return
      patch.mark = value
    }
    if (field === IB_TICK.OPEN || field === IB_TICK.DELAYED_OPEN) {
      if (value <= 0) return
      patch.open = value
    }
    if (field === IB_TICK.HIGH) {
      if (value <= 0) return
      patch.high = value
    }
    if (field === IB_TICK.LOW) {
      if (value <= 0) return
      patch.low = value
    }
    if (field === IB_TICK.CLOSE || field === IB_TICK.DELAYED_CLOSE) {
      if (value <= 0) return
      patch.previousClose = value
    }
    if (Object.keys(patch).length === 0) return
    if (marketQuoteHasPrice({ ...patch } as MarketQuote)) {
      if (subscription.retryTimer) clearTimeout(subscription.retryTimer)
      subscription.retryTimer = undefined
      subscription.retryAttempt = 0
      const delayedTick =
        field === IB_TICK.DELAYED_BID ||
        field === IB_TICK.DELAYED_ASK ||
        field === IB_TICK.DELAYED_LAST
      patch.status = delayedTick || (subscription.marketDataType ?? 1) !== 1 ? 'delayed' : 'ok'
      patch.marketDataType = marketDataTypeName(
        delayedTick && subscription.marketDataType !== 4 ? 3 : (subscription.marketDataType ?? 1),
      )
      patch.unavailableReason = undefined
      patch.ibkrErrorCode = undefined
    }
    this.upsertQuoteWithPatch(quote, patch)
  }

  handleTickSize(reqId: number, field?: number, value?: number): void {
    if (field == null || value == null || !Number.isFinite(value)) return
    const quote = this.quoteForRequest(reqId)
    if (!quote) return
    const key = this.quoteRequestIds.get(reqId)
    const subscription = key == null ? undefined : this.quoteSubscriptions.get(key)
    if (!subscription) return
    const observedAt = new Date().toISOString()
    const normalizedSize = value >= 0 ? value : undefined
    const patch: Partial<MarketQuote> = {}
    if (field === IB_TICK.BID_SIZE || field === IB_TICK.DELAYED_BID_SIZE) {
      const pendingPrice = subscription.pendingBidPrice
      if (pendingPrice !== undefined && normalizedSize !== undefined) {
        subscription.pendingBidPrice = undefined
        if (pendingPrice < 0 || normalizedSize === 0) {
          // Price -1/0 followed by size 0: the bid is unavailable.
          patch.bid = undefined
          patch.bidSize = undefined
          patch.bidUpdatedAt = undefined
        } else {
          // A zero price followed by positive size is a valid quote (for example, a combo).
          patch.bid = pendingPrice
          patch.bidSize = normalizedSize
          patch.bidUpdatedAt = observedAt
        }
      } else {
        patch.bidSize = normalizedSize
        // A size tick must not refresh the side timestamp after its price was withdrawn.
        if (quote.bid != null) patch.bidUpdatedAt = observedAt
      }
    }
    if (field === IB_TICK.ASK_SIZE || field === IB_TICK.DELAYED_ASK_SIZE) {
      const pendingPrice = subscription.pendingAskPrice
      if (pendingPrice !== undefined && normalizedSize !== undefined) {
        subscription.pendingAskPrice = undefined
        if (pendingPrice < 0 || normalizedSize === 0) {
          patch.ask = undefined
          patch.askSize = undefined
          patch.askUpdatedAt = undefined
        } else {
          patch.ask = pendingPrice
          patch.askSize = normalizedSize
          patch.askUpdatedAt = observedAt
        }
      } else {
        patch.askSize = normalizedSize
        if (quote.ask != null) patch.askUpdatedAt = observedAt
      }
    }
    if (field === IB_TICK.VOLUME || field === IB_TICK.DELAYED_VOLUME) {
      patch.volume = normalizedSize
    }
    if (Object.keys(patch).length === 0) return
    // A positive size can resolve a provisional zero price into a valid quote.
    if (marketQuoteHasPrice({ ...quote, ...patch })) {
      const delayedTick = field === IB_TICK.DELAYED_BID_SIZE || field === IB_TICK.DELAYED_ASK_SIZE
      if (subscription.retryTimer) clearTimeout(subscription.retryTimer)
      subscription.retryTimer = undefined
      subscription.retryAttempt = 0
      patch.status = delayedTick || (subscription.marketDataType ?? 1) !== 1 ? 'delayed' : 'ok'
      patch.marketDataType = marketDataTypeName(
        delayedTick && subscription.marketDataType !== 4 ? 3 : (subscription.marketDataType ?? 1),
      )
      patch.unavailableReason = undefined
      patch.ibkrErrorCode = undefined
    }
    this.upsertQuoteWithPatch(quote, patch)
  }

  handleMarketDataType(reqId: number, marketDataType: number): void {
    const quote = this.quoteForRequest(reqId)
    if (!quote) return
    const key = this.quoteRequestIds.get(reqId)
    const subscription = key == null ? undefined : this.quoteSubscriptions.get(key)
    if (!subscription) return
    subscription.marketDataType = marketDataType
    if (!marketQuoteHasPrice(quote)) return
    const status =
      marketDataType === 1
        ? 'ok'
        : marketDataType >= 2 && marketDataType <= 4
          ? 'delayed'
          : quote.status
    this.upsertQuoteWithPatch(quote, {
      status,
      marketDataType: marketDataTypeName(marketDataType),
    })
  }

  private quoteForRequest(reqId: number): MarketQuote | undefined {
    const key = this.quoteRequestIds.get(reqId)
    if (!key) return undefined
    const subscription = this.quoteSubscriptions.get(key)
    if (!subscription) return undefined
    return (
      this.store.getState().quotes.find((quote) => brokerSymbolKey(quote.symbol) === key) ?? {
        symbol: subscription.symbol,
        timestamp: new Date().toISOString(),
        status: 'ok',
      }
    )
  }

  private upsertQuoteWithPatch(quote: MarketQuote, patch: Partial<MarketQuote>): void {
    const next: MarketQuote = {
      ...quote,
      ...patch,
      timestamp: marketQuoteHasPrice(patch as MarketQuote)
        ? new Date().toISOString()
        : quote.timestamp,
      status: patch.status ?? quote.status ?? 'ok',
    }
    if (next.last != null && next.previousClose != null) {
      next.change = next.last - next.previousClose
      next.changePercent =
        next.previousClose !== 0 ? (next.change / next.previousClose) * 100 : undefined
    } else {
      next.change = undefined
      next.changePercent = undefined
    }
    this.store.upsertQuote(next)
  }
}

function marketDataTypeName(marketDataType: number): MarketQuote['marketDataType'] {
  return ({ 1: 'live', 2: 'frozen', 3: 'delayed', 4: 'delayed-frozen' } as const)[marketDataType]
}
