import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter'

afterEach(() => vi.unstubAllGlobals())

it('binds option contract resolution to the configured execution environment', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        tradable: true,
        contract: {
          underlying: 'AAPL',
          underlyingSymbolInfo: {
            symbol: 'AAPL',
            exchange: 'SMART',
            primaryExchange: 'NASDAQ',
            currency: 'USD',
            assetClass: 'stock',
          },
          expiration: '2026-10-16',
          strike: 200,
          right: 'call',
          multiplier: 100,
          exchange: 'SMART',
          currency: 'USD',
          symbol: 'AAPL  261016C00200000',
          brokerContractId: 123,
          priceStep: 0.005,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const broker = createIbkrHttpBrokerAdapter({
    baseUrl: 'http://localhost:3000/api/v1/ibkr',
    executionEnvironment: 'paper',
  })
  if (!broker.resolveOptionContract) throw new Error('Option resolution is required')

  const resolution = await broker.resolveOptionContract({
    accountId: 'DU123',
    contract: {
      underlying: 'AAPL',
      underlyingSymbolInfo: {
        ticker: 'AAPL',
        brokerSymbol: 'AAPL',
        exchange: 'SMART',
        listedExchange: 'NASDAQ',
        currency: 'USD',
        type: 'stock',
      },
      expiration: '2026-10-16',
      strike: 200,
      right: 'call',
      multiplier: 100,
      exchange: 'SMART',
      currency: 'USD',
      priceStep: 0.005,
    },
  })

  expect(resolution.contract.priceStep).toBe(0.005)

  expect(fetchMock).toHaveBeenCalledOnce()
  const [, init] = fetchMock.mock.calls[0] ?? []
  expect(JSON.parse(String(init?.body))).toMatchObject({
    expectedExecutionEnvironment: 'paper',
    accountId: 'DU123',
    contract: {
      underlying: 'AAPL',
      expiration: '2026-10-16',
      strike: 200,
      right: 'call',
      priceStep: 0.005,
    },
  })
})
