import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrMarketDatafeed } from './market-datafeed.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('carries the gateway listing group on each search result', async () => {
  vi.stubEnv('VITE_LOGO_DEV_PUBLISHABLE_KEY', 'pk_test_logo_key')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([
        {
          symbol: {
            ticker: 'AAPL',
            canonicalSymbol: 'IBKR:265598',
            exchange: 'SMART',
            primaryExchange: 'NASDAQ',
            currency: 'USD',
            type: 'stock',
            isin: 'US0378331005',
          },
          displayName: 'AAPL',
          provider: 'IBKR',
          group: { key: 'IBKR-ISSUER:e1359061:AAPL', label: 'AAPL' },
        },
        {
          symbol: { ticker: 'EURUSD', exchange: 'IDEALPRO', currency: 'USD', type: 'forex' },
          displayName: 'EURUSD',
          provider: 'IBKR',
        },
      ]),
    ),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const results = await feed.searchSymbols?.({ searchText: 'AAPL' })
  expect(results?.[0]?.group).toEqual({ key: 'IBKR-ISSUER:e1359061:AAPL', label: 'AAPL' })
  expect(results?.[1]).not.toHaveProperty('group')
  expect(new URL(results?.[0]?.symbol.logoUrl ?? '').pathname).toBe('/isin/US0378331005')
  expect(results?.[1]?.symbol).not.toHaveProperty('logoUrl')
})

it('requests sparklines per shared contract identity and returns each line on the requested symbol', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    return Response.json(
      url.searchParams.getAll('symbol').map((symbol) => ({
        symbol: {
          symbol,
          exchange: url.searchParams.get('exchange') ?? undefined,
          currency: url.searchParams.get('currency') ?? undefined,
        },
        values: [1, 2, 3],
      })),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
  const aapl = {
    ticker: 'AAPL',
    canonicalSymbol: 'IBKR:265598',
    exchange: 'SMART',
    listedExchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock' as const,
  }
  const msft = { ...aapl, ticker: 'MSFT', canonicalSymbol: 'IBKR:272093' }
  const btc = { ticker: 'BTC', exchange: 'PAXOS', currency: 'USD', type: 'crypto' as const }
  if (!feed.getSparklines) throw new Error('Sparklines required')
  const lines = await feed.getSparklines({ symbols: [aapl, msft, btc] })

  expect(fetchMock).toHaveBeenCalledTimes(2)
  const requests = fetchMock.mock.calls.map((call) => new URL(String(call[0])))
  expect(requests.map((url) => url.pathname)).toEqual(['/api/sparklines', '/api/sparklines'])
  expect(requests.map((url) => url.searchParams.getAll('symbol'))).toEqual([
    ['AAPL', 'MSFT'],
    ['BTC'],
  ])
  expect(Object.fromEntries(requests[0]?.searchParams ?? [])).toMatchObject({
    exchange: 'SMART',
    primaryExchange: 'NASDAQ',
    currency: 'USD',
    assetClass: 'stock',
  })
  expect(lines).toEqual([
    { symbol: aapl, values: [1, 2, 3] },
    { symbol: msft, values: [1, 2, 3] },
    { symbol: btc, values: [1, 2, 3] },
  ])
})
