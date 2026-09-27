import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('passes IBKR contract-detail durations to the SDK symbol contract', async () => {
  const supportedDurations = [
    { type: 'day' as const, value: 'day', label: 'DAY', default: true },
    { type: 'ioc' as const, value: 'ioc', label: 'IOC' },
    { type: 'custom' as const, value: 'opg', label: 'OPG' },
    { type: 'custom' as const, value: 'overnight-day', label: 'OVERNIGHT + DAY' },
  ]
  const fetchMock = vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify({ metadata: { supportedDurations } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })

  const context = {
    symbol: {
      ticker: 'AAPL',
      brokerSymbol: 'AAPL',
      exchange: 'SMART',
      listedExchange: 'NASDAQ',
      currency: 'USD',
      type: 'stock',
    },
  } as const
  const info = await broker.getTradingSymbolInfo?.(context)
  await broker.getTradingSymbolInfo?.(context)

  expect(info?.supportedDurations).toEqual(supportedDurations)
  expect(fetchMock).toHaveBeenCalledWith(
    'http://localhost:3000/api/v1/ibkr/sessions?symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock',
    expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
