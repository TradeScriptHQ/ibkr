import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrMarketDatafeed } from './market-datafeed.js'

afterEach(() => vi.unstubAllGlobals())

it('requests the selected contract and preserves missing fundamentals as null', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      symbol: { ticker: 'AAPL', primaryExchange: 'NASDAQ', currency: 'USD' },
      name: 'APPLE INC',
      industry: 'Technology',
      minTick: 0.01,
      source: 'IBKR contract details',
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  const symbol = {
    ticker: 'AAPL',
    exchange: 'SMART',
    listedExchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock' as const,
  }
  const result = await createIbkrMarketDatafeed().getInstrumentDetails?.({ symbol })
  const url = new URL(fetcher.mock.calls[0]?.[0], 'http://localhost')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    symbol: 'AAPL',
    exchange: 'SMART',
    primaryExchange: 'NASDAQ',
    currency: 'USD',
    assetClass: 'stock',
  })
  expect(result?.symbol).toEqual(symbol)
  expect(result?.fundamentalFields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'name', value: 'APPLE INC' }),
      expect.objectContaining({ id: 'category', value: null }),
      expect.objectContaining({ id: 'min-tick', value: 0.01 }),
    ]),
  )
  expect(result?.marketCap).toBeUndefined()
})

it('keeps provider failures visible instead of returning fabricated details', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
  await expect(
    createIbkrMarketDatafeed().getInstrumentDetails?.({ symbol: { ticker: 'AAPL' } }),
  ).rejects.toMatchObject({ code: 'datafeed.request-failed', details: { status: 503 } })
})
