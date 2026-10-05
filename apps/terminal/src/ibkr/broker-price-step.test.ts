import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter.js'
import { createIbkrMarketDatafeed } from './market-datafeed.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('does not advertise a smallest native tick as an authoritative order price step', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        symbol: { minTick: 0.005 },
        metadata: { minQuantity: 0.01, quantityStep: 0.01, contractMultiplier: 1 },
      }),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })

  const info = await broker.getTradingSymbolInfo?.({
    symbol: {
      ticker: 'AAPL',
      brokerSymbol: 'AAPL',
      exchange: 'SMART',
      listedExchange: 'NASDAQ',
      currency: 'USD',
      type: 'stock',
    },
  })

  expect(info?.priceStep).toBeUndefined()
  expect(info?.minQuantity).toBe(0.01)
  expect(info?.quantityStep).toBe(0.01)
  expect(info?.minNotional).toBeUndefined()
  expect(info?.supportsShortSelling).toBe(true)
  expect(info?.supportsTrailingStop).toBe(false)
  expect(info?.supportedOrderTypes).toContain('trailing-stop')
})

it('preserves every native market-rule band for validation at the proposed price', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        symbol: {
          minTick: 0.01,
          priceIncrements: [
            { lowEdge: 0, increment: 0.01 },
            { lowEdge: 1, increment: 0.05 },
          ],
        },
        metadata: {},
      }),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })

  const info = await broker.getTradingSymbolInfo?.({
    symbol: {
      ticker: 'TEST',
      exchange: 'SMART',
      currency: 'USD',
      type: 'stock',
    },
    lastPrice: 1.2,
  })

  expect(info?.priceStep).toBeUndefined()
  expect(info).toHaveProperty('priceIncrements', [
    { lowEdge: 0, increment: 0.01 },
    { lowEdge: 1, increment: 0.05 },
  ])
})

it('preserves IBKR minimum-tick metadata when resolving a chart symbol', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ticker: 'TEST',
        exchange: 'SMART',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
        type: 'stock',
        minTick: 0.005,
      }),
    ),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost:3000/api/v1/ibkr' })

  const symbol = await feed.resolveSymbol?.('TEST')

  expect(symbol).toMatchObject({
    tickSize: 0.005,
    pricePrecision: 3,
    pricescale: 1_000,
    minMove: 5,
  })
})

it('preserves the complete IBKR variable-tick structure on a resolved symbol', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ticker: 'TEST',
        exchange: 'SMART',
        currency: 'USD',
        type: 'stock',
        minTick: 0.01,
        priceIncrements: [
          { lowEdge: 0, increment: 0.01 },
          { lowEdge: 1, increment: 0.05 },
        ],
      }),
    ),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost:3000/api/v1/ibkr' })

  const symbol = await feed.resolveSymbol?.('TEST')

  expect(symbol?.priceFormat).toMatchObject({
    priceScale: 100,
    minMove: 1,
    variableTickSize: '0.01 1 0.05',
  })
})

it('leaves native order price authority unavailable when broker details fail', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  )
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })

  const info = await broker.getTradingSymbolInfo?.({
    symbol: {
      ticker: 'TEST',
      currency: 'USD',
      type: 'stock',
      pricescale: 20,
      minMove: 1,
    },
  })

  expect(info?.priceStep).toBeUndefined()
  expect(info).not.toHaveProperty('priceIncrements')
  expect(info).toHaveProperty('monetaryValueAvailable', false)
})

it('requires broker futures metadata and never substitutes stock rules after a failed request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ error: { message: 'Contract metadata unavailable' } }, { status: 503 }),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })
  await expect(
    broker.getTradingSymbolInfo?.({
      symbol: {
        ticker: 'MESZ6',
        brokerSymbol: 'IBKR:123',
        canonicalSymbol: 'IBKR:123',
        exchange: 'CME',
        currency: 'USD',
        type: 'futures',
      },
    }),
  ).rejects.toThrow()
})

it('advertises only the futures order types returned by the selected contract', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        symbol: { minTick: 0.25, priceIncrements: [{ lowEdge: 0, increment: 0.25 }] },
        metadata: {
          minQuantity: 1,
          quantityStep: 1,
          contractMultiplier: 5,
          orderTypes: 'LMT,MKT',
          supportedDurations: [{ type: 'day', label: 'DAY' }],
        },
      }),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })
  const info = await broker.getTradingSymbolInfo?.({
    symbol: {
      ticker: 'MESZ6',
      brokerSymbol: 'IBKR:123',
      canonicalSymbol: 'IBKR:123',
      exchange: 'CME',
      currency: 'USD',
      type: 'futures',
    },
  })
  expect(info?.supportedOrderTypes).toEqual(['market', 'limit'])
  expect(info?.contractMultiplier).toBe(5)
})

it('advertises cash entry and IOC-only market orders for IBKR crypto', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        symbol: { minTick: 0.01 },
        metadata: {
          minQuantity: 0.00000001,
          quantityStep: 0.00000001,
          orderTypes: 'LMT,MKT',
          supportedDurations: [{ type: 'gtc', label: 'GTC' }],
        },
      }),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })

  const info = await broker.getTradingSymbolInfo?.({
    symbol: {
      ticker: 'BTC',
      brokerSymbol: 'BTC',
      exchange: 'PAXOS',
      currency: 'USD',
      type: 'crypto',
    },
  })

  expect(info?.supportedOrderTypes).toEqual(['market', 'limit'])
  expect(info?.supportedDurations).toEqual([
    { type: 'day', label: 'DAY', supportedOrderTypes: ['limit'] },
    { type: 'gtc', label: 'GTC', supportedOrderTypes: ['limit'] },
    { type: 'ioc', label: 'IOC', supportedOrderTypes: ['market', 'limit'] },
  ])
  expect(info?.cashQuantity).toEqual({
    supportedSides: ['buy'],
    supportedOrderTypes: ['market'],
    minAmount: 1,
    amountStep: 0.01,
    quickAmounts: [10, 25, 50, 100],
  })
})

it.each(['bond', 'warrant', 'commodity', 'cfd'] as const)(
  'requires broker sizing and order rules for a native %s ticket',
  async (type) => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        symbol: { minTick: 0.01, priceIncrements: [{ lowEdge: 0, increment: 0.01 }] },
        metadata: { minQuantity: 2, quantityStep: 2, orderTypes: 'LMT', contractMultiplier: 10 },
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const broker = createIbkrHttpBrokerAdapter({
      baseUrl: 'http://localhost:3000/api/v1/ibkr',
      executionEnvironment: 'paper',
    })
    const symbol = {
      ticker: 'DISPLAY',
      canonicalSymbol: 'IBKR:123',
      brokerSymbol: 'IBKR:123',
      type,
      currency: 'EUR',
      exchange: 'SMART',
    }
    const result = await broker.isTradable?.({ symbol })
    expect(result).toMatchObject({
      tradable: true,
      symbolRules: {
        minQuantity: 2,
        quantityStep: 2,
        contractMultiplier: 10,
        supportedOrderTypes: ['limit'],
      },
    })
    expect(String(fetch.mock.calls[0]?.[0])).toContain('symbol=IBKR%3A123')
  },
)

it('keeps a bond with missing broker currency visible but untradable', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })
  expect(
    await broker.isTradable?.({
      symbol: { ticker: 'US-T', brokerSymbol: 'IBKR:123', type: 'bond', exchange: 'SMART' },
    }),
  ).toMatchObject({ tradable: false, reason: expect.stringContaining('contract currency') })
  expect(fetch).not.toHaveBeenCalled()
})

it('preserves bond sizing while leaving missing contract currency unknown', async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({
      symbol: {
        minTick: 0.00001,
        currency: '',
        priceIncrements: [{ lowEdge: 0, increment: 0.00001 }],
      },
      metadata: { minQuantity: 1, quantityStep: 1, orderTypes: 'LMT,MKT,DAY' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })
  const context = {
    symbol: {
      ticker: 'IBKR:456',
      brokerSymbol: 'IBKR:456',
      canonicalSymbol: 'IBKR:456',
      exchange: 'SMART',
      type: 'bond' as const,
    },
    currency: 'USD',
  }
  const info = await broker.getTradingSymbolInfo?.(context)
  expect(info).toMatchObject({ minQuantity: 1, quantityStep: 1 })
  expect(info?.priceStep).toBeUndefined()
  expect(info).toHaveProperty('priceIncrements', [{ lowEdge: 0, increment: 0.00001 }])
  expect(info?.currency).toBeUndefined()
  expect(info?.contractMultiplier).toBeUndefined()
  expect(await broker.isTradable?.(context)).toMatchObject({
    tradable: false,
    reason: expect.stringContaining('contract currency'),
  })
})

it.each([
  { priceIncrements: [{ lowEdge: 0, increment: 0 }] },
  {
    priceIncrements: [
      { lowEdge: 0, increment: 0.01 },
      { lowEdge: 0, increment: 0.05 },
    ],
  },
  {
    priceIncrements: [
      { lowEdge: 1, increment: 0.05 },
      { lowEdge: 0, increment: 0.01 },
    ],
  },
])(
  'does not replace invalid native market rules with minTick metadata',
  async ({ priceIncrements }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ symbol: { minTick: 0.01, priceIncrements }, metadata: {} }),
      ),
    )
    const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
    const info = await broker.getTradingSymbolInfo?.({
      symbol: { ticker: 'TEST', currency: 'USD', type: 'stock' },
    })
    expect(info?.priceStep).toBeUndefined()
    expect(info).not.toHaveProperty('priceIncrements')
    expect(info).not.toHaveProperty('routingDestination')
  },
)

it('retains explicit unknown native monetary units without changing raw price rules or currency', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        symbol: { minTick: 0.000001, priceIncrements: [{ lowEdge: 0, increment: 0.5 }] },
        metadata: {
          monetaryValueAvailable: false,
          monetaryValueUnavailableReason: 'Native quote monetary units are unavailable.',
        },
      }),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const symbol = { ticker: 'TEST', currency: 'GBP', type: 'stock' as const }
  const info = await broker.getTradingSymbolInfo?.({ symbol, lastPrice: 7250.89532 })
  expect(info).toMatchObject({
    symbol,
    currency: 'GBP',
    monetaryValueAvailable: false,
    monetaryValueUnavailableReason: 'Native quote monetary units are unavailable.',
    priceIncrements: [{ lowEdge: 0, increment: 0.5 }],
  })
  expect(info?.priceStep).toBeUndefined()
})

it('loads and caches rules for the selected order route independently of the symbol quote route', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const route = new URL(String(input)).searchParams.get('exchange')
    return Response.json({
      symbol: { priceIncrements: [{ lowEdge: 0, increment: route === 'ARCA' ? 0.25 : 0.01 }] },
      metadata: {},
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const symbol = { ticker: 'TEST', exchange: 'SMART', currency: 'USD', type: 'stock' as const }
  const selected = { symbol, routingDestination: 'ARCA' }
  expect(await broker.getTradingSymbolInfo?.({ symbol })).toHaveProperty('priceIncrements', [
    { lowEdge: 0, increment: 0.01 },
  ])
  const selectedInfo = await broker.getTradingSymbolInfo?.(selected)
  expect(selectedInfo).toHaveProperty('priceIncrements', [{ lowEdge: 0, increment: 0.25 }])
  expect(selectedInfo).toHaveProperty('routingDestination', 'ARCA')
  await broker.getTradingSymbolInfo?.(selected)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('exchange')).toBe('ARCA')
})
