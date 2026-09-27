import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter'
import { toBackendDraft } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('provider-aware advanced order controls', () => {
  it('passes IBKR contract-detail capabilities to the SDK symbol contract', async () => {
    const routingDestinations = [
      { value: 'SMART', label: 'SMART' },
      { value: 'ISLAND', label: 'ISLAND' },
    ]
    const allOrNone = {
      supported: true,
      default: false,
      supportedOrderTypes: ['limit' as const],
    }
    const oca = {
      behaviors: [
        { value: 'cancel-with-block', label: 'Cancel remaining orders with block' },
        { value: 'reduce-with-block', label: 'Reduce remaining orders with block' },
      ],
      defaultBehavior: 'cancel-with-block',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              metadata: {
                supportedDurations: [{ type: 'day', value: 'day', label: 'DAY' }],
                routingDestinations,
                defaultRoutingDestination: 'SMART',
                allOrNone,
                oca,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    )
    const broker = createIbkrHttpBrokerAdapter({
      baseUrl: 'http://localhost:3000/api/v1/ibkr',
      providerName: 'IBKR',
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

    expect(info).toMatchObject({
      routingDestinations,
      defaultRoutingDestination: 'SMART',
      allOrNone,
      oca,
    })
  })

  it('does not advertise IBKR controls for another provider', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const broker = createIbkrHttpBrokerAdapter({ providerName: 'Alpaca' })

    const info = await broker.getTradingSymbolInfo?.({
      symbol: { ticker: 'AAPL', currency: 'USD', type: 'stock' },
    })

    expect(info?.routingDestinations).toBeUndefined()
    expect(info?.allOrNone).toBeUndefined()
    expect(info?.oca).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves destination, All-or-None and OCA in the gateway draft', () => {
    expect(
      toBackendDraft({
        accountId: 'DU123',
        symbol: {
          ticker: 'AAPL',
          brokerSymbol: 'AAPL',
          exchange: 'SMART',
          listedExchange: 'NASDAQ',
          currency: 'USD',
          type: 'stock',
        },
        side: 'buy',
        type: 'limit',
        duration: { type: 'day' },
        quantity: 10,
        price: 100,
        routingDestination: 'ISLAND',
        allOrNone: true,
        oca: { groupId: 'pair-42', behavior: 'reduce-with-block' },
      }),
    ).toMatchObject({
      symbol: { exchange: 'SMART', primaryExchange: 'NASDAQ' },
      routingDestination: 'ISLAND',
      allOrNone: true,
      oca: { groupId: 'pair-42', behavior: 'reduce-with-block' },
    })
  })

  it('preserves gateway readback in the SDK order record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              connectionStatus: 'connected',
              activeAccountId: 'DU123',
              accounts: [{ id: 'DU123', label: 'Paper', currency: 'USD' }],
              orders: [
                {
                  id: '1401',
                  brokerOrderId: 1401,
                  accountId: 'DU123',
                  symbol: {
                    symbol: 'AAPL',
                    exchange: 'SMART',
                    primaryExchange: 'NASDAQ',
                    currency: 'USD',
                    assetClass: 'stock',
                  },
                  side: 'buy',
                  type: 'limit',
                  duration: 'day',
                  quantity: 10,
                  limitPrice: 100,
                  routingDestination: 'ISLAND',
                  allOrNone: true,
                  oca: { groupId: 'pair-42', behavior: 'reduce-without-block' },
                  status: 'working',
                  submittedAt: '2026-09-10T10:00:00.000Z',
                  updatedAt: '2026-09-10T10:00:01.000Z',
                },
              ],
              positions: [],
              executions: [],
              quotes: [],
              messages: [],
              updatedAt: '2026-09-10T10:00:01.000Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    )
    const broker = createIbkrHttpBrokerAdapter({
      baseUrl: 'http://localhost:3000/api/v1/ibkr',
      providerName: 'IBKR',
      executionEnvironment: 'paper',
    })

    const state = await broker.getState()

    expect(state.orders[0]).toMatchObject({
      routingDestination: 'ISLAND',
      allOrNone: true,
      oca: { groupId: 'pair-42', behavior: 'reduce-without-block' },
    })
  })

  it('preserves advanced-field replacements and OCA removal in modification previews', async () => {
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ accepted: true, source: 'local' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const broker = createIbkrHttpBrokerAdapter({
      baseUrl: 'http://localhost:3000/api/v1/ibkr',
      providerName: 'IBKR',
      executionEnvironment: 'paper',
      csrfToken: 'test-csrf',
    })

    await broker.previewModifyOrder?.(
      '1402',
      { routingDestination: 'SMART', allOrNone: false, oca: null },
      {
        accountId: 'DU123',
        symbol: {
          ticker: 'AAPL',
          brokerSymbol: 'AAPL',
          exchange: 'SMART',
          listedExchange: 'NASDAQ',
          currency: 'USD',
          type: 'stock',
        },
      },
    )

    expect(requestBody).toMatchObject({
      patch: { routingDestination: 'SMART', allOrNone: false, oca: null },
      expectedExecutionEnvironment: 'paper',
    })
  })
})
