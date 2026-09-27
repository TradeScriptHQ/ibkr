import { expect, it, vi } from 'vitest'
import { depthStatusMessage } from './depth-status.js'
import { createIbkrMarketDatafeed } from './market-datafeed.js'

it.each([
  ['delayed', 'Best bid/ask only · Level II unavailable · Delayed quotes'],
  ['ok', 'Best bid/ask only · Level II unavailable'],
])('describes top-of-book coverage for %s quotes', (quoteStatus, expected) => {
  const symbol = { ticker: 'AAPL', exchange: 'SMART', currency: 'USD' }
  expect(
    depthStatusMessage(symbol, {
      symbol,
      bids: [{ price: 100, size: 10 }],
      asks: [{ price: 101, size: 20 }],
      timestamp: Date.now(),
      metadata: {
        depthSource: 'top-of-book',
        quoteStatus,
        depthDiagnostic: { code: 2152, message: 'Missing depth permissions' },
      },
    }),
  ).toBe(expected)
})

it('carries the actual broker depth diagnostic through the feed to the empty-state label', async () => {
  const symbol = { ticker: 'AAPL', exchange: 'SMART', currency: 'USD' }
  const message =
    'Exchanges - Top: IBEOS; OVERNIGHT; Need additional market data permissions - Depth: NASDAQ; ARCA;'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        symbol: { symbol: 'AAPL' },
        bids: [],
        asks: [],
        updatedAt: new Date().toISOString(),
        diagnostic: { code: 2152, message },
      }),
    ),
  )
  try {
    const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
    if (!feed.getDepth) throw new Error('Depth support required')
    const depth = await feed.getDepth({ symbol })
    expect(depthStatusMessage(symbol, depth)).toBe(
      `AAPL market depth unavailable.\nIBKR 2152: ${message}`,
    )
    expect(depthStatusMessage(symbol)).toBe('Waiting for AAPL market depth from IBKR.')
  } finally {
    vi.unstubAllGlobals()
  }
})
