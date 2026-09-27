import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrMarketDatafeed } from './market-datafeed.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('declares the required SMART venue for spot-metal discovery', async () => {
  const search = (await createIbkrMarketDatafeed().onReady?.())?.symbolSearch
  expect(search?.assetTypes?.find((option) => option.value === 'commodity')).toEqual({
    value: 'commodity',
    label: 'Spot metals / commodities',
    requiresExchange: true,
    exchanges: [{ value: 'SMART', label: 'SMART' }],
  })
})

it('advertises and resolves the range-aware IBKR session calendar', async () => {
  const startTime = Date.parse('2026-09-11T04:00:00Z')
  const endTime = Date.parse('2026-09-12T04:00:00Z')
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    Response.json({
      symbol: {
        ticker: 'AAPL',
        exchange: 'SMART',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
        type: 'stock',
      },
      timezone: 'America/New_York',
      coverage: { startTime, endTime },
      windows: [
        {
          opensAt: Date.parse('2026-09-11T08:00:00Z'),
          closesAt: Date.parse('2026-09-11T13:30:00Z'),
          state: 'pre-market',
        },
      ],
      source: 'ibkr-historical-schedule',
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })

  expect(feed.onReady?.()).toMatchObject({ supportsSessionCalendar: true })
  const calendar = await feed.resolveSessionCalendar?.({
    symbol: {
      ticker: 'AAPL',
      brokerSymbol: 'AAPL',
      exchange: 'SMART',
      listedExchange: 'NASDAQ',
      currency: 'USD',
      type: 'stock',
    },
    sourceInterval: '1m',
    targetInterval: '1m',
    startTime,
    endTime,
  })

  expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
    `/session-calendar?symbol=AAPL&startTime=${startTime}&endTime=${endTime}`,
  )
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain('primaryExchange=NASDAQ')
  expect(calendar).toEqual({
    symbol: expect.objectContaining({ ticker: 'AAPL', listedExchange: 'NASDAQ' }),
    timezone: 'America/New_York',
    coverage: { startTime, endTime },
    windows: [
      {
        opensAt: Date.parse('2026-09-11T08:00:00Z'),
        closesAt: Date.parse('2026-09-11T13:30:00Z'),
        state: 'pre-market',
      },
    ],
    metadata: { provider: 'ibkr-historical-schedule' },
  })
})

it('uses fresh quote sizes as a labeled top-of-book fallback when depth is denied', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-09-09T08:00:00Z')
  vi.setSystemTime(now)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/depth?')) {
        return Response.json({
          symbol: { symbol: 'SPY', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
          bids: [],
          asks: [],
          updatedAt: new Date(now).toISOString(),
          diagnostic: { code: 2152, message: 'Exchanges - Top: IBEOS; OVERNIGHT;' },
        })
      }
      return Response.json([
        {
          symbol: { symbol: 'SPY', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
          bid: 762.94,
          bidSize: 320,
          ask: 762.96,
          askSize: 1_640,
          timestamp: new Date(now).toISOString(),
          status: 'delayed',
        },
      ])
    }),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const symbol = { ticker: 'SPY', exchange: 'SMART', currency: 'USD', type: 'stock' as const }
  const depth = await feed.getDepth?.({ symbol, levels: 20 })
  expect(depth).toMatchObject({
    symbol,
    bids: [{ price: 762.94, size: 320, exchange: 'IBKR TOP', tier: 'Top of book' }],
    asks: [{ price: 762.96, size: 1_640, exchange: 'IBKR TOP', tier: 'Top of book' }],
    timestamp: now,
    diagnostic: { provider: 'IBKR', code: 2152, reason: 'Exchanges - Top: IBEOS; OVERNIGHT;' },
    metadata: {
      depthDiagnostic: { code: 2152 },
      depthSource: 'top-of-book',
      depthCoverage: 'Best bid and ask only; Level II unavailable.',
      quoteStatus: 'delayed',
    },
  })
})

it('expires top-of-book fallback rows and lets genuine depth replace them', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-09-09T08:00:00Z')
  vi.setSystemTime(now)
  let source: EventTarget | undefined
  class TestEventSource extends EventTarget {
    close = vi.fn()
    constructor() {
      super()
      source = this
    }
  }
  vi.stubGlobal('EventSource', TestEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/depth?')) {
        return Response.json({
          symbol: { symbol: 'SPY', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
          bids: [],
          asks: [],
          updatedAt: new Date(now).toISOString(),
          diagnostic: { code: 2152, message: 'Depth permission required.' },
        })
      }
      return Response.json([
        {
          symbol: { symbol: 'SPY', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
          bid: 762.94,
          bidSize: 320,
          ask: 762.96,
          askSize: 1_640,
          timestamp: new Date(now).toISOString(),
          status: 'ok',
        },
      ])
    }),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  if (!feed.subscribeDepth) throw new Error('Depth subscription required')
  const symbol = { ticker: 'SPY', exchange: 'SMART', currency: 'USD', type: 'stock' as const }
  const callback = vi.fn()
  const stop = feed.subscribeDepth({ id: 'depth', symbol, levels: 20 }, callback)
  try {
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(callback.mock.lastCall?.[0]).toMatchObject({
      bids: [{ price: 762.94, size: 320 }],
      asks: [{ price: 762.96, size: 1_640 }],
      metadata: { depthSource: 'top-of-book' },
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(callback.mock.lastCall?.[0]).toMatchObject({ bids: [], asks: [] })
    if (!source) throw new Error('Stream did not start')
    source.dispatchEvent(
      new MessageEvent('market-depth', {
        data: JSON.stringify({
          type: 'market-depth',
          marketDepth: {
            symbol: { symbol: 'SPY', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
            bids: [{ price: 762.93, size: 280, marketMaker: 'NASDAQ' }],
            asks: [{ price: 762.97, size: 400, marketMaker: 'ARCA' }],
            updatedAt: new Date(now + 10_000).toISOString(),
          },
        }),
      }),
    )
    expect(callback.mock.lastCall?.[0]).toMatchObject({
      bids: [{ price: 762.93, size: 280, exchange: 'NASDAQ' }],
      asks: [{ price: 762.97, size: 400, exchange: 'ARCA' }],
      metadata: {},
    })
  } finally {
    stop()
  }
})

it('expires displayed depth prices without new ticks while keeping risk quote reads unchanged', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-09-09T08:00:00Z')
  vi.setSystemTime(now)
  let source: EventTarget | undefined
  class TestEventSource extends EventTarget {
    close = vi.fn()
    constructor() {
      super()
      source = this
    }
  }
  vi.stubGlobal('EventSource', TestEventSource)
  const raw = {
    symbol: { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
    status: 'unavailable',
    timestamp: new Date(now).toISOString(),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([raw])),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  if (!feed.subscribeQuotes || !feed.getQuotes) throw new Error('Quote operations required')
  const callback = vi.fn()
  const stop = feed.subscribeQuotes({ id: 'ticket', symbols: ['AAPL'] }, callback)
  try {
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    if (!source) throw new Error('Stream did not start')
    source.dispatchEvent(
      new MessageEvent('market-depth', {
        data: JSON.stringify({
          type: 'market-depth',
          marketDepth: {
            symbol: raw.symbol,
            updatedAt: new Date(now).toISOString(),
            bids: [{ price: 317, size: 10, marketMaker: 'IBEOS' }],
            asks: [{ price: 318, size: 10, marketMaker: 'OVERNIGHT' }],
          },
        }),
      }),
    )
    expect(callback.mock.lastCall?.[0]?.[0]).toMatchObject({
      bid: 317,
      ask: 318,
      status: 'unavailable',
      bidAskSource: { kind: 'order-book', expiresAt: now + 10_000 },
    })
    const riskQuotes = await feed.getQuotes({ symbols: ['AAPL'] })
    expect(riskQuotes[0]?.status).toBe('unavailable')
    expect(riskQuotes[0]?.bid).toBeUndefined()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(callback.mock.lastCall?.[0]?.[0]?.status).toBe('unavailable')
    expect(callback.mock.lastCall?.[0]?.[0]?.bid).toBeUndefined()
    expect(callback.mock.lastCall?.[0]?.[0]?.timestamp).toBe(now)
    const count = callback.mock.calls.length
    stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(callback).toHaveBeenCalledTimes(count)
  } finally {
    stop()
  }
})

it('shares one stream across quote and depth subscribers and releases it only after the last unsubscribe', async () => {
  const sources: TestEventSource[] = []
  class TestEventSource extends EventTarget {
    close = vi.fn()
    constructor() {
      super()
      sources.push(this)
    }
  }
  vi.stubGlobal('EventSource', TestEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(
        url.includes('/depth?')
          ? { symbol: { symbol: 'AAPL' }, bids: [], asks: [], updatedAt: '2026-09-09T08:00:00Z' }
          : [],
      ),
    ),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const { subscribeQuotes, subscribeDepth } = feed
  if (!subscribeQuotes || !subscribeDepth) throw new Error('Streaming is required')
  const symbol = { ticker: 'AAPL', exchange: 'SMART', currency: 'USD', type: 'stock' as const }
  const callbacks = Array.from({ length: 8 }, () => vi.fn())
  const stops = callbacks.map((callback, index) =>
    subscribeQuotes({ id: `quotes-${index}`, symbols: [symbol] }, callback),
  )
  const stopDepth = subscribeDepth({ id: 'depth', symbol }, vi.fn())
  expect(sources).toHaveLength(1)
  const source = sources[0]
  const stopFirst = stops[0]
  if (!source || !stopFirst) throw new Error('Stream did not start')
  await vi.waitFor(() => expect(callbacks[0]).toHaveBeenCalled())
  for (const callback of callbacks) callback.mockClear()
  stopFirst()
  stopFirst()
  source.dispatchEvent(
    new MessageEvent('quotes', {
      data: JSON.stringify({
        type: 'quotes',
        quotes: [
          {
            symbol: { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
            bid: 123,
            timestamp: '2026-09-09T08:00:00Z',
          },
        ],
      }),
    }),
  )
  expect(callbacks[0]).not.toHaveBeenCalled()
  for (const callback of callbacks.slice(1)) expect(callback.mock.calls[0]?.[0]?.[0]?.bid).toBe(123)
  for (const stop of stops.slice(1)) stop()
  expect(source.close).not.toHaveBeenCalled()
  stopDepth()
  stopDepth()
  expect(source.close).toHaveBeenCalledTimes(1)
  const stopNew = subscribeQuotes({ id: 'new', symbols: [symbol] }, vi.fn())
  expect(sources).toHaveLength(2)
  stopNew()
  expect(sources[1]?.close).toHaveBeenCalledTimes(1)
})

it('develops the current chart bar from the same live last trade as the order ticket', async () => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-09-14T20:28:30Z')
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  })
  let source: EventTarget | undefined
  class TestEventSource extends EventTarget {
    close = vi.fn()
    constructor() {
      super()
      source = this
    }
  }
  vi.stubGlobal('EventSource', TestEventSource)
  let barReads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/quotes?')) {
        return Response.json([
          {
            symbol: { symbol: 'FTFT', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
            last: 7.1807,
            timestamp: '2026-09-14T20:28:25Z',
            status: 'ok',
            marketDataType: 'live',
          },
        ])
      }
      barReads += 1
      return Response.json({
        bars:
          barReads === 1
            ? [
                {
                  time: Date.parse('2026-09-14T20:28:00Z'),
                  open: 7.15,
                  high: 7.17,
                  low: 7.14,
                  close: 7.16,
                  volume: 100,
                },
              ]
            : [
                {
                  time: Date.parse('2026-09-14T20:29:00Z'),
                  open: 7.18,
                  high: 7.19,
                  low: 7.17,
                  close: 7.18,
                  volume: 25,
                },
              ],
        hasOlder: true,
        hasNewer: false,
        dataUnavailable: false,
      })
    }),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api', pollMs: 2_500 })
  if (!feed.subscribeRealTimeBars) throw new Error('Realtime bars are required')
  const symbol = {
    ticker: 'FTFT',
    brokerSymbol: 'FTFT',
    exchange: 'SMART',
    listedExchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock' as const,
  }
  const callback = vi.fn()
  const stop = feed.subscribeRealTimeBars({ id: 'ftft-bars', symbol, interval: '1m' }, callback)
  try {
    await vi.waitFor(() =>
      expect(callback.mock.lastCall?.[0]).toMatchObject({
        time: Date.parse('2026-09-14T20:28:00Z'),
        high: 7.1807,
        close: 7.1807,
        volume: 100,
      }),
    )
    if (!source) throw new Error('Stream did not start')
    source.dispatchEvent(
      new MessageEvent('quotes', {
        data: JSON.stringify({
          type: 'quotes',
          quotes: [
            {
              symbol: {
                symbol: 'FTFT',
                exchange: 'SMART',
                currency: 'USD',
                assetClass: 'stock',
              },
              last: 7.19,
              timestamp: '2026-09-14T20:28:40Z',
              status: 'ok',
              marketDataType: 'live',
            },
          ],
        }),
      }),
    )
    expect(callback.mock.lastCall?.[0]).toMatchObject({ high: 7.19, close: 7.19 })

    const liveCallCount = callback.mock.calls.length
    source.dispatchEvent(
      new MessageEvent('quotes', {
        data: JSON.stringify({
          type: 'quotes',
          quotes: [
            {
              symbol: {
                symbol: 'FTFT',
                exchange: 'SMART',
                currency: 'USD',
                assetClass: 'stock',
              },
              last: 7.25,
              timestamp: '2026-09-14T20:28:45Z',
              status: 'delayed',
              marketDataType: 'delayed-frozen',
            },
          ],
        }),
      }),
    )
    expect(callback).toHaveBeenCalledTimes(liveCallCount)

    source.dispatchEvent(
      new MessageEvent('quotes', {
        data: JSON.stringify({
          type: 'quotes',
          quotes: [
            {
              symbol: {
                symbol: 'FTFT',
                exchange: 'SMART',
                currency: 'USD',
                assetClass: 'stock',
              },
              last: 7.17,
              timestamp: '2026-09-14T20:28:30Z',
              status: 'ok',
              marketDataType: 'live',
            },
          ],
        }),
      }),
    )
    expect(callback.mock.lastCall?.[0]).toMatchObject({ high: 7.19, close: 7.19 })

    const callCount = callback.mock.calls.length
    source.dispatchEvent(
      new MessageEvent('quotes', {
        data: JSON.stringify({
          type: 'quotes',
          quotes: [
            {
              symbol: {
                symbol: 'FTFT',
                exchange: 'SMART',
                currency: 'USD',
                assetClass: 'stock',
              },
              last: 7.2,
              timestamp: '2026-09-14T20:29:05Z',
              status: 'ok',
              marketDataType: 'live',
            },
          ],
        }),
      }),
    )
    expect(callback).toHaveBeenCalledTimes(callCount)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(callback.mock.lastCall?.[0]).toMatchObject({
      time: Date.parse('2026-09-14T20:29:00Z'),
      high: 7.2,
      close: 7.2,
      volume: 25,
    })
  } finally {
    stop()
  }
})

it('carries the gateway quote diagnostic into SDK metadata without inventing prices', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([
        {
          symbol: { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
          timestamp: '2026-09-09T08:00:00Z',
          status: 'unavailable',
          unavailableReason: 'Additional API subscription required.',
          ibkrErrorCode: 10089,
        },
      ]),
    ),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const quotes = await feed.getQuotes?.({ symbols: ['AAPL'] })
  expect(quotes?.[0]).toMatchObject({
    status: 'unavailable',
    diagnostic: {
      provider: 'IBKR',
      reason: 'Additional API subscription required.',
      code: 10089,
    },
  })
  expect(quotes?.[0]?.bid).toBeUndefined()
  expect(quotes?.[0]?.ask).toBeUndefined()
  expect(quotes?.[0]?.last).toBeUndefined()
})

it('passes the listing exchange to the quote request independently of the trading route', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json([]))
  vi.stubGlobal('fetch', fetchMock)
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  await feed.getQuotes?.({
    symbols: [
      {
        ticker: 'AAPL',
        exchange: 'SMART',
        listedExchange: 'NASDAQ',
        type: 'stock',
        currency: 'USD',
      },
    ],
  })
  const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
  expect(url.searchParams.get('exchange')).toBe('SMART')
  expect(url.searchParams.get('primaryExchange')).toBe('NASDAQ')
})

it('keeps feed type and mark metadata separate from session and last trade', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([
        {
          symbol: { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
          status: 'delayed',
          marketDataType: 'delayed-frozen',
          timestamp: '2026-09-13T10:00:00Z',
          bid: 100,
          ask: 102,
          mark: 101,
        },
      ]),
    ),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const quote = (await feed.getQuotes?.({ symbols: ['AAPL'] }))?.[0]
  expect(quote?.last).toBeUndefined()
  expect(quote?.metadata).toMatchObject({
    provider: 'IBKR',
    marketDataType: 'delayed-frozen',
    referencePrice: 101,
    referencePriceKind: 'mark',
  })
  expect(quote?.metadata?.sessionStatus).toBeUndefined()
})

it('uses provider option tick times for freshness and never substitutes mark for last', async () => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-09-13T10:00:10Z')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        underlying: 'AAPL',
        expirations: [
          {
            expiration: '2026-09-18',
            contracts: [
              {
                contract: {
                  underlying: 'AAPL',
                  expiration: '2026-09-18',
                  strike: 250,
                  right: 'call',
                  multiplier: 100,
                  priceStep: 0.005,
                  priceIncrements: [
                    { lowEdge: 0, increment: 0.005 },
                    { lowEdge: 1, increment: 0.01 },
                  ],
                },
                bid: 1.2,
                ask: 1.3,
                mark: 1.25,
                quoteTimestamp: '2026-09-13T10:00:04Z',
                marketDataType: 'frozen',
              },
            ],
          },
        ],
      }),
    ),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const series = await feed.getOptionQuotes?.({ symbol: 'AAPL', expiration: '2026-09-18' })
  expect(series?.quote_timestamp).toBe(Date.parse('2026-09-13T10:00:04Z'))
  expect(series?.quote_freshness).toEqual({
    last_update: Date.parse('2026-09-13T10:00:04Z'),
    age_ms: 6000,
    status: 'current',
  })
  expect(series?.contracts[0]?.last_price).toBeUndefined()
  expect(series?.contracts[0]?.theoretical_price).toBe(1.25)
  expect(series?.contracts[0]?.price_step).toBe(0.01)
  expect(series?.contracts[0]?.last_update).toBe(Date.parse('2026-09-13T10:00:04Z'))
  expect(series?.contracts[0]?.metrics).toEqual({ ibkrMarketDataType: 'frozen' })
})

it('streams option quote snapshots from the dedicated chain event source', () => {
  let source: TestEventSource | undefined
  class TestEventSource extends EventTarget {
    close = vi.fn()
    constructor(readonly url: string) {
      super()
      source = this
    }
  }
  vi.stubGlobal('EventSource', TestEventSource)
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const callback = vi.fn()
  const stop = feed.subscribeOptionQuotes?.(
    {
      id: 'option-quotes-1',
      symbol: { ticker: 'AAPL', exchange: 'SMART', currency: 'USD', type: 'stock' },
      expiration: '2026-09-18',
      centerPrice: 250,
      quoteWindowRows: 20,
    },
    callback,
  )
  if (!source || !stop) throw new Error('Option quote stream did not start')
  expect(source.url).toContain('/options/chain/events?')
  expect(source.url).toContain('expiration=2026-09-18')
  expect(source.url).toContain('maxQuoteContracts=40')

  source.dispatchEvent(
    new MessageEvent('option-quotes', {
      data: JSON.stringify({
        underlying: 'AAPL',
        expirations: [
          {
            expiration: '2026-09-18',
            contracts: [
              {
                contract: {
                  underlying: 'AAPL',
                  expiration: '2026-09-18',
                  strike: 250,
                  right: 'call',
                  multiplier: 100,
                },
                bid: 1.24,
                ask: 1.26,
                quoteTimestamp: '2026-09-13T10:00:04Z',
                marketDataType: 'live',
              },
            ],
          },
        ],
      }),
    }),
  )

  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      contracts: [expect.objectContaining({ bid_price: 1.24, ask_price: 1.26 })],
    }),
  )
  stop()
  expect(source.close).toHaveBeenCalledTimes(1)
})

it.each([undefined, 40])(
  'preserves the catalog and honors the requested row window %s without a hidden cap',
  async (quoteWindowRows) => {
    const strikes = [300, 302.5, 305, 307.5, 310, 312.5, 315, 317.5, 320, 350]
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        underlying: 'AAPL',
        expirations: [
          {
            expiration: '2026-09-09',
            contracts: strikes.map((strike) => ({
              contract: {
                underlying: 'AAPL',
                expiration: '2026-09-09',
                strike,
                right: 'call',
                multiplier: 100,
                priceStep: 0.005,
              },
            })),
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
    const series = await feed.getOptionQuotes?.({
      symbol: 'AAPL',
      expiration: '2026-09-09',
      ...(quoteWindowRows == null ? {} : { quoteWindowRows }),
    })
    expect(series?.strikes).toEqual(strikes)
    expect(series?.contracts.every((contract) => contract.price_step === 0.005)).toBe(true)
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(url.searchParams.has('quoteWindowRows')).toBe(false)
    expect(url.searchParams.get('maxQuoteContracts')).toBe(quoteWindowRows == null ? null : '80')
  },
)

it.each([undefined, '', '   ', 'Requested API market data requires a subscription.'])(
  'includes provider details only for a specific quote message: %s',
  async (reason) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          {
            symbol: { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
            status: 'delayed',
            timestamp: '2026-09-09T08:00:00Z',
            last: 313,
            unavailableReason: reason,
            ibkrErrorCode: 10089,
          },
        ]),
      ),
    )
    const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
    if (!feed.getQuotes) throw new Error('Quote reads are required')
    const quote = (await feed.getQuotes({ symbols: ['AAPL'] }))[0]
    expect(quote?.status).toBe('delayed')
    expect(quote?.last).toBe(313)
    expect(quote?.metadata?.provider).toBe('IBKR')
    expect(quote?.diagnostic).toEqual(
      reason?.trim() ? { provider: 'IBKR', reason: reason.trim(), code: 10089 } : undefined,
    )
  },
)

it('preserves a selected international listing when resolving its SDK descriptor', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    Response.json({
      ticker: 'SAP',
      exchange: 'SMART',
      primaryExchange: 'IBIS',
      currency: 'EUR',
      type: 'stock',
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const resolved = await feed.resolveSymbol?.({
    ticker: 'SAP',
    exchange: 'SMART',
    listedExchange: 'IBIS',
    currency: 'EUR',
    type: 'stock',
  })
  const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
  expect(Object.fromEntries(url.searchParams)).toEqual({
    symbol: 'SAP',
    exchange: 'SMART',
    primaryExchange: 'IBIS',
    currency: 'EUR',
    assetClass: 'stock',
  })
  expect(resolved).toMatchObject({ ticker: 'SAP', currency: 'EUR', listedExchange: 'IBIS' })
})

it('keeps same-ticker listings in separate SDK instrument identities', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const currency = new URL(String(input)).searchParams.get('currency')
      return Response.json({
        ticker: 'SAP',
        currency,
        exchange: 'SMART',
        type: 'stock',
        canonicalSymbol: currency === 'EUR' ? 'IBKR:100' : 'IBKR:200',
      })
    }),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const euro = await feed.resolveSymbol?.({ ticker: 'SAP', type: 'stock', currency: 'EUR' })
  const dollar = await feed.resolveSymbol?.({ ticker: 'SAP', type: 'stock', currency: 'USD' })
  expect(euro?.canonicalSymbol).toBe('IBKR:100')
  expect(dollar?.canonicalSymbol).toBe('IBKR:200')
})
