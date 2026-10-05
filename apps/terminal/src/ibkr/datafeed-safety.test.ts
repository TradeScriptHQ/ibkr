import { afterEach, expect, it, vi } from 'vitest'
import { loadBars, toOptionSeriesSnapshot } from './datafeed-requests.js'
import { createIbkrMarketDatafeed } from './market-datafeed.js'

const symbol = {
  ticker: 'TEST',
  brokerSymbol: 'TEST',
  exchange: 'SMART',
  listedExchange: 'TEST-LISTING',
  currency: 'USD',
  type: 'stock' as const,
}
const bar = (time: number) => ({ time, open: 100, high: 100, low: 100, close: 100, volume: 10 })
const depth = () => ({
  symbol: {
    symbol: 'TEST',
    exchange: 'SMART',
    primaryExchange: 'TEST-LISTING',
    currency: 'USD',
    assetClass: 'stock',
  },
  bids: [{ price: 99, size: 10 }],
  asks: [{ price: 101, size: 10 }],
  updatedAt: new Date().toISOString(),
})
const chain = (marketDataType: 'live' | 'delayed' | 'frozen' | 'delayed-frozen') => ({
  underlying: 'TEST',
  expirations: [
    {
      expiration: '2026-10-16',
      contracts: [
        {
          contract: {
            underlying: 'TEST',
            underlyingSymbolInfo: {
              symbol: 'TEST',
              currency: 'USD',
              assetClass: 'stock',
              exchange: 'SMART',
            },
            expiration: '2026-10-16',
            strike: 100,
            right: 'call' as const,
            multiplier: 100,
          },
          last: 2,
          bid: 1,
          ask: 3,
          quoteTimestamp: new Date().toISOString(),
          marketDataType,
        },
      ],
    },
  ],
})
function events() {
  let source: EventTarget | undefined
  class TestEventSource extends EventTarget {
    close = vi.fn()
    constructor() {
      super()
      source = this
    }
  }
  vi.stubGlobal('EventSource', TestEventSource)
  vi.stubGlobal('window', globalThis)
  return (name: string, data?: unknown) => {
    if (!source) throw new Error('Test stream not started')
    source.dispatchEvent(
      data === undefined ? new Event(name) : new MessageEvent(name, { data: JSON.stringify(data) }),
    )
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(['initial', 'older', 'newer'] as const)(
  'returns only valid %s window/anchor rows and preserves listing identity',
  async (loadDirection) => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({ bars: [-1, 0, 1, 9, 10, 11].map(bar), hasOlder: false, hasNewer: false }),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await loadBars('http://localhost/api', symbol, '1s', {
      startTime: 0,
      endTime: 10,
      barCount: 10,
      loadDirection,
    })
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('primaryExchange')).toBe(
      'TEST-LISTING',
    )
    expect(result.bars.map((row) => row.time)).toEqual(
      loadDirection === 'newer'
        ? [1, 9, 10]
        : loadDirection === 'older'
          ? [0, 1, 9]
          : [0, 1, 9, 10],
    )
  },
)

it('retries failed depth, reports failure truthfully and clears retry work on unsubscribe', async () => {
  vi.useFakeTimers()
  events()
  let requests = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (!String(url).includes('/depth?')) return Response.json([])
      requests += 1
      return requests === 1
        ? Response.json({ error: 'Test depth unavailable' }, { status: 503 })
        : Response.json(depth())
    }),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const callback = vi.fn()
  const stop = feed.subscribeDepth?.({ id: 'test-depth', symbol }, callback)
  await vi.advanceTimersByTimeAsync(0)
  expect(callback.mock.lastCall?.[0]).toMatchObject({ status: 'failed', bids: [], asks: [] })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(requests).toBe(2)
  expect(callback.mock.lastCall?.[0].bids).toHaveLength(1)
  stop?.()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(requests).toBe(2)
})

it('re-establishes depth after stream open and broker recovery', async () => {
  vi.useFakeTimers()
  const send = events()
  const fetch = vi.fn(async (url) => Response.json(String(url).includes('/depth?') ? depth() : []))
  vi.stubGlobal('fetch', fetch)
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const callback = vi.fn()
  const stop = feed.subscribeDepth?.({ id: 'test-depth', symbol }, callback)
  await vi.advanceTimersByTimeAsync(0)
  send('connection-status', { type: 'connection-status', status: 'disconnected' })
  expect(callback.mock.lastCall?.[0]).toMatchObject({ status: 'stale', bids: [], asks: [] })
  send('connection-status', { type: 'connection-status', status: 'connected' })
  await vi.advanceTimersByTimeAsync(0)
  send('open')
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch.mock.calls.filter((call) => String(call[0]).includes('/depth?'))).toHaveLength(3)
  send('connection-status', { type: 'connection-status', status: 'disconnected' })
  send('open')
  send('state', { type: 'state', state: { connectionStatus: 'connected', quotes: [] } })
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch.mock.calls.filter((call) => String(call[0]).includes('/depth?'))).toHaveLength(4)
  stop?.()
})

it('replaces the tape snapshot when provider sequence resets and catches transient poll errors', async () => {
  vi.useFakeTimers()
  events()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  let attempt = 0
  const fetch = vi.fn(async () => {
    attempt += 1
    if (attempt === 2) return Response.json({ error: 'Temporary test failure' }, { status: 503 })
    const sequence = attempt === 1 ? 100 : 1
    return Response.json([
      { id: `print-${attempt}`, sequence, time: Date.now(), price: 100, size: 1 },
    ])
  })
  vi.stubGlobal('fetch', fetch)
  const callback = vi.fn()
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const stop = feed.subscribeTimeAndSales?.({ id: 'test-tape', symbol }, callback)
  await vi.advanceTimersByTimeAsync(1_500)
  expect(callback).toHaveBeenCalledTimes(2)
  expect(callback.mock.lastCall?.[0]).toMatchObject({ snapshot: true, prints: [{ sequence: 1 }] })
  stop?.()
  const calls = fetch.mock.calls.length
  await vi.advanceTimersByTimeAsync(5_000)
  expect(fetch).toHaveBeenCalledTimes(calls)
})

it.each(['delayed', 'frozen', 'delayed-frozen'] as const)(
  'never labels %s option quotes current',
  (marketDataType) => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-09-30T10:00:00Z')
    expect(toOptionSeriesSnapshot(chain(marketDataType), '/test').quote_freshness.status).toBe(
      marketDataType,
    )
  },
)

it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
  'keeps provider option ticks without guessing a price band for %s',
  (last) => {
    const source = chain('live')
    const item = source.expirations[0]?.contracts[0]
    if (!item) throw new Error('Test option is required')
    const snapshot = toOptionSeriesSnapshot(
      {
        ...source,
        expirations: [
          {
            expiration: '2026-10-16',
            contracts: [
              {
                ...item,
                last,
                bid: undefined,
                ask: undefined,
                contract: {
                  ...item.contract,
                  priceStep: 0.02,
                  priceIncrements: [{ lowEdge: 0, increment: 0.001 }],
                },
              },
            ],
          },
        ],
      },
      '/test',
    )
    expect(snapshot.contracts[0]?.price_step).toBe(0.02)
  },
)

it('re-evaluates live option freshness after a quiet stream and stops expiry callbacks on unsubscribe', async () => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-09-30T10:00:00Z')
  const send = events()
  const callback = vi.fn()
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const stop = feed.subscribeOptionQuotes?.(
    { id: 'test-options', symbol, expiration: '2026-10-16' },
    callback,
  )
  send('option-quotes', chain('live'))
  expect(callback.mock.lastCall?.[0].quote_freshness.status).toBe('current')
  await vi.advanceTimersByTimeAsync(15_001)
  expect(callback.mock.lastCall?.[0].quote_freshness.status).toBe('stale')
  stop?.()
  const count = callback.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(callback).toHaveBeenCalledTimes(count)
})

it('covers the complete one-second polling horizon', async () => {
  vi.useFakeTimers()
  events()
  const fetch = vi.fn(async (url) =>
    Response.json(String(url).includes('/bars?') ? { bars: [] } : []),
  )
  vi.stubGlobal('fetch', fetch)
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const stop = feed.subscribeRealTimeBars?.({ id: 'one-second', symbol, interval: '1s' }, vi.fn())
  await vi.advanceTimersByTimeAsync(0)
  const path = fetch.mock.calls.find((call) => String(call[0]).includes('/bars?'))?.[0]
  const params = new URL(String(path)).searchParams
  expect(Number(params.get('barCount'))).toBeGreaterThanOrEqual(18)
  expect(Number(params.get('endTime')) - Number(params.get('startTime'))).toBeGreaterThanOrEqual(
    18_000,
  )
  stop?.()
})

it.each(['1D', '1M'] as const)(
  'keeps provider %s candles unchanged without verified session/calendar boundaries',
  async (interval) => {
    vi.useFakeTimers()
    const start = Date.parse('2026-02-01T00:00:00Z')
    vi.setSystemTime(start + 12 * 3_600_000)
    events()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        Response.json(
          String(url).includes('/bars?')
            ? { bars: [bar(start)] }
            : [
                {
                  symbol: {
                    symbol: 'TEST',
                    exchange: 'SMART',
                    primaryExchange: 'TEST-LISTING',
                    currency: 'USD',
                    assetClass: 'stock',
                  },
                  last: 150,
                  timestamp: new Date().toISOString(),
                  status: 'ok',
                  marketDataType: 'live',
                },
              ],
        ),
      ),
    )
    const callback = vi.fn()
    const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
    const stop = feed.subscribeRealTimeBars?.({ id: 'calendar', symbol, interval }, callback)
    await vi.advanceTimersByTimeAsync(0)
    expect(callback.mock.lastCall?.[0]).toMatchObject({ time: start, high: 100, close: 100 })
    stop?.()
  },
)

it('transports explicit provider trading classes and preserves per-contract native class metadata', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL) =>
    Response.json({
      ...chain('live'),
      tradingClass: 'TEST1',
      tradingClasses: [
        { id: 'TEST', exchange: 'SMART', multiplier: 100 },
        { id: 'TEST1', exchange: 'SMART', multiplier: 100 },
      ],
      expirations: chain('live').expirations.map((expiry) => ({
        ...expiry,
        contracts: expiry.contracts.map((row) => ({
          ...row,
          contract: { ...row.contract, tradingClass: 'TEST1', brokerContractId: 222 },
        })),
      })),
    }),
  )
  vi.stubGlobal('fetch', fetch)
  const feed = createIbkrMarketDatafeed({ baseUrl: '/api' })
  const request = { symbol, tradingClass: 'TEST1', includeTradingClasses: true }
  const snapshot = await feed.getOptionContracts?.(request)
  const url = new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost')
  expect(url.searchParams.get('tradingClass')).toBe('TEST1')
  expect(url.searchParams.get('includeTradingClasses')).toBe('true')
  const contract = snapshot?.contracts[0]
  expect(contract && 'trading_class' in contract ? contract.trading_class : undefined).toBe('TEST1')
  expect(snapshot?.contracts[0]?.code).toBe('222')
})
