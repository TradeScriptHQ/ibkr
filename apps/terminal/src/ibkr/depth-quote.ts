import type { Quote } from '@tradescript/pro/sdk'

export const DEPTH_QUOTE_MAX_AGE_MS = 10_000

export interface QuoteDepthSnapshot {
  symbol: {
    symbol: string
    exchange?: string | undefined
    currency?: string | undefined
    assetClass?: string | undefined
  }
  bids: Array<{ price: number; size: number; marketMaker?: string | undefined }>
  asks: Array<{ price: number; size: number; marketMaker?: string | undefined }>
  updatedAt: string
}

export function withDepthQuote(
  quote: Quote,
  depth: QuoteDepthSnapshot | undefined,
  now: number,
): Quote {
  const positive = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value > 0
  // Keep the provider's usable standard quote; this fallback never manufactures a trade price.
  if (quote.status !== 'unavailable' && [quote.bid, quote.ask, quote.last].some(positive))
    return quote
  if (
    !depth ||
    depth.symbol.symbol !== (quote.symbol.brokerSymbol ?? quote.symbol.ticker) ||
    !depth.symbol.currency ||
    depth.symbol.currency !== quote.symbol.currency ||
    depth.symbol.exchange !== quote.symbol.exchange ||
    depth.symbol.assetClass !== quote.symbol.type
  )
    return quote
  const timestamp = Date.parse(depth.updatedAt)
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp >= DEPTH_QUOTE_MAX_AGE_MS)
    return quote
  const bids = depth.bids.filter((level) => positive(level.price) && positive(level.size))
  const asks = depth.asks.filter((level) => positive(level.price) && positive(level.size))
  const bid = Math.max(...bids.map((level) => level.price))
  const ask = Math.min(...asks.map((level) => level.price))
  if (!positive(bid) || !positive(ask) || bid > ask) return quote
  const venues = [
    ...new Set(
      [
        ...bids.filter((level) => level.price === bid),
        ...asks.filter((level) => level.price === ask),
      ].map((level) => level.marketMaker ?? 'Unknown venue'),
    ),
  ]
  const overnight = venues.every((venue) => ['IBEOS', 'OVERNIGHT'].includes(venue))
  const { last: _last, ...withoutLast } = quote
  return {
    ...withoutLast,
    bid,
    ask,
    spread: ask - bid,
    // Preserve the standard stream's status and timestamp. The SDK now understands a
    // separate, expiring order-book source for these bid/ask values.
    bidAskSource: {
      kind: 'order-book',
      provider: 'IBKR',
      venues,
      coverage: overnight ? 'Overnight' : 'Available venues only',
      timestamp,
      expiresAt: timestamp + DEPTH_QUOTE_MAX_AGE_MS,
      status: 'live',
    },
  }
}
