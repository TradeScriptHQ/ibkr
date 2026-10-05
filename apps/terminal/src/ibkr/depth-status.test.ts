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

it.each([
  [
    'Gateway depth pending: IBKR has not returned rows or a request-specific diagnostic.',
    'Waiting for AAPL market depth from IBKR.',
  ],
  [
    'Gateway depth no response: IBKR has not returned rows or a request-specific diagnostic within 15 seconds; availability is unknown.',
    'AAPL market depth has not responded. Availability is unknown.',
  ],
])('keeps local depth observation distinct from a native error: %s', async (message, expected) => {
  const symbol = { ticker: 'AAPL', exchange: 'SMART', currency: 'USD', type: 'stock' as const }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      Response.json(
        String(url).includes('/quotes')
          ? [{ symbol: { symbol: 'AAPL' }, status: 'unavailable', ibkrErrorCode: 10197 }]
          : {
              symbol: { symbol: 'AAPL' },
              bids: [],
              asks: [],
              updatedAt: new Date().toISOString(),
              diagnostic: { message },
            },
      ),
    ),
  )
  try {
    const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
    if (!feed.getDepth) throw new Error('Depth support required')
    const depth = await feed.getDepth({ symbol })
    expect(depth.bids).toEqual([])
    expect(depth.asks).toEqual([])
    expect(depth.diagnostic?.code).toBeUndefined()
    expect(depth.diagnostic?.provider).toBe('IBKR gateway')
    expect(depth.diagnostic?.reason).toBe(message)
    expect(depthStatusMessage(symbol, depth)).toBe(expected)
    expect(depthStatusMessage(symbol, depth)).not.toContain('10197')
    expect(depthStatusMessage(symbol, depth)).not.toContain('unavailable')
  } finally {
    vi.unstubAllGlobals()
  }
})

it.each([
  ['Gateway depth pending:', 'Best bid/ask only · Waiting for Level II', 'waiting for Level II'],
  [
    'Gateway depth no response:',
    'Best bid/ask only · Level II has not responded',
    'Level II has not responded',
  ],
])(
  'a real top-of-book fallback retains the local Level II observation: %s',
  async (message, expected, coverage) => {
    const symbol = { ticker: 'AAPL', exchange: 'SMART', currency: 'USD', type: 'stock' as const }
    const backendSymbol = {
      symbol: 'AAPL',
      assetClass: 'stock',
      exchange: 'SMART',
      currency: 'USD',
    }
    const timestamp = new Date().toISOString()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        Response.json(
          String(url).includes('/quotes')
            ? [
                {
                  symbol: backendSymbol,
                  status: 'ok',
                  bid: 100,
                  ask: 101,
                  bidSize: 10,
                  askSize: 20,
                  timestamp,
                },
              ]
            : {
                symbol: backendSymbol,
                bids: [],
                asks: [],
                updatedAt: timestamp,
                diagnostic: { message },
              },
        ),
      ),
    )
    try {
      const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
      if (!feed.getDepth) throw new Error('Depth support required')
      const depth = await feed.getDepth({ symbol })
      expect(depth.bids).toHaveLength(1)
      expect(depth.asks).toHaveLength(1)
      expect(depth.metadata?.depthSource).toBe('top-of-book')
      expect(depth.metadata?.depthCoverage).toContain(coverage)
      expect(depthStatusMessage(symbol, depth)).toBe(expected)
    } finally {
      vi.unstubAllGlobals()
    }
  },
)

it('does not turn untyped metadata into a native provider error', () => {
  const symbol = { ticker: 'AAPL', exchange: 'SMART', currency: 'USD' }
  expect(
    depthStatusMessage(symbol, {
      symbol,
      bids: [],
      asks: [],
      timestamp: Date.now(),
      metadata: { depthDiagnostic: { message: 'Invented permission error', code: 10197 } },
    }),
  ).toBe('Waiting for AAPL market depth from IBKR.')
})
