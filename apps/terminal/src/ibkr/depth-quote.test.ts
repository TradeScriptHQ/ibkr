import type { Quote } from '@tradescript/pro/sdk'
import { expect, it } from 'vitest'
import { DEPTH_QUOTE_MAX_AGE_MS, type QuoteDepthSnapshot, withDepthQuote } from './depth-quote.js'

const now = Date.parse('2026-09-09T08:00:00Z')
const quote: Quote = {
  symbol: { ticker: 'AAPL', exchange: 'SMART', currency: 'USD', type: 'stock' },
  status: 'unavailable',
  diagnostic: { provider: 'IBKR', reason: 'Standard stream has no prices.' },
}
const depth: QuoteDepthSnapshot = {
  symbol: { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
  bids: [
    { price: 317.02, size: 31, marketMaker: 'IBEOS' },
    { price: 317, size: 50, marketMaker: 'OVERNIGHT' },
  ],
  asks: [{ price: 317.16, size: 40, marketMaker: 'OVERNIGHT' }],
  updatedAt: new Date(now - 1000).toISOString(),
}

it('derives best prices and provenance without inventing a last trade or losing the original diagnostic', () => {
  const value = withDepthQuote(quote, depth, now)
  expect(value).toMatchObject({ bid: 317.02, ask: 317.16, status: 'unavailable' })
  expect(value.last).toBeUndefined()
  expect(value.bidAskSource).toMatchObject({
    kind: 'order-book',
    provider: 'IBKR',
    venues: ['IBEOS', 'OVERNIGHT'],
    coverage: 'Overnight',
    timestamp: now - 1000,
    expiresAt: now - 1000 + DEPTH_QUOTE_MAX_AGE_MS,
    status: 'live',
  })
  expect(value.diagnostic).toEqual(quote.diagnostic)
  expect(value.timestamp).toBe(quote.timestamp)
  expect(quote.bid).toBeUndefined()
})

it.each(['symbol', 'currency', 'exchange', 'assetClass'] as const)(
  'rejects a mismatched %s',
  (field) => {
    expect(
      withDepthQuote(quote, { ...depth, symbol: { ...depth.symbol, [field]: 'OTHER' } }, now),
    ).toBe(quote)
  },
)

it('expires depth prices and rejects future timestamps', () => {
  expect(withDepthQuote(quote, depth, now - 1000 + DEPTH_QUOTE_MAX_AGE_MS)).toBe(quote)
  expect(
    withDepthQuote(quote, { ...depth, updatedAt: new Date(now + 1000).toISOString() }, now),
  ).toBe(quote)
})

it('rejects empty, zero-size and crossed books', () => {
  expect(withDepthQuote(quote, { ...depth, asks: [] }, now)).toBe(quote)
  expect(withDepthQuote(quote, { ...depth, asks: [{ price: 317.16, size: 0 }] }, now)).toBe(quote)
  expect(withDepthQuote(quote, { ...depth, asks: [{ price: 316, size: 1 }] }, now)).toBe(quote)
})

it('prefers recovered standard quotes and does not label other venues overnight', () => {
  const recovered: Quote = { ...quote, bid: 318, ask: 319, last: 318.5, status: 'ok' }
  expect(withDepthQuote(recovered, depth, now)).toBe(recovered)
  const value = withDepthQuote(
    quote,
    { ...depth, bids: [{ price: 317, size: 1, marketMaker: 'ARCA' }] },
    now,
  )
  expect(value.bidAskSource).toMatchObject({
    venues: ['ARCA', 'OVERNIGHT'],
    coverage: 'Available venues only',
  })
})
