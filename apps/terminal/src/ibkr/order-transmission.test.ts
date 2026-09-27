import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter'
import { TWS_HELD_MESSAGE } from './order-transmission'

const warning =
  'You are trying to submit an order without having market data for this instrument. IBKR strongly recommends against this kind of blind trading which may result in erroneous or unexpected trades. Restriction is specified in Precautionary Settings of Global Configuration/Presets. (354 req 1259)'

afterEach(() => vi.unstubAllGlobals())

function serveOrder(status: string, message: string = warning) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            connectionStatus: 'connected',
            accounts: [],
            positions: [],
            executions: [],
            messages: [],
            orders: [
              {
                id: '1259',
                accountId: 'DU123',
                symbol: {
                  ticker: 'AAPL',
                  brokerSymbol: 'AAPL',
                  assetClass: 'stock',
                  currency: 'USD',
                  exchange: 'SMART',
                },
                side: 'buy',
                type: 'market',
                quantity: 1,
                filledQuantity: 0,
                remainingQuantity: 1,
                duration: 'DAY',
                submittedAt: '2026-09-09T15:23:57.050Z',
                updatedAt: '2026-09-09T15:23:57.143Z',
                status,
                message,
              },
            ],
          }),
        ),
    ),
  )
}

it.each(['placing', 'pre-submitted', 'inactive'])(
  'shows the transmission precaution as held for %s orders',
  async (status) => {
    serveOrder(status)
    const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
    const order = (await broker.getState()).orders[0]
    if (!order) throw new Error('Expected the broker order')
    expect(order.status).toBe('inactive')
    expect(order.message).toBe(`${TWS_HELD_MESSAGE}\n${warning}`)
    expect(order.metadata).toMatchObject({
      brokerStatus: status,
      brokerMessage: warning,
      transmissionStatus: 'held',
      requiresTwsAttention: true,
    })
  },
)

it.each(['working', 'partially-filled', 'filled', 'cancelled', 'expired'])(
  'clears the held presentation after %s acknowledgement',
  async (status) => {
    const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
    serveOrder('placing')
    expect((await broker.getState()).orders[0]?.message).toContain(TWS_HELD_MESSAGE)
    serveOrder(status)
    const order = (await broker.getState()).orders[0]
    if (!order) throw new Error('Expected the broker order')
    expect(order.status).toBe(status)
    expect(order.message).toBeUndefined()
    expect(order.metadata).toEqual({ brokerStatus: status, brokerMessage: warning })
  },
)

it.each([
  ['placing', 'Order precaution warning. (399 req 1259)'],
  ['placing', 'Requested market data is not subscribed. (354 req 1259)'],
  ['rejected', warning],
  ['cancelling', 'Cancellation requested. Waiting for IBKR acknowledgement.'],
])('preserves unrelated warnings and newer order outcomes: %s / %s', async (status, message) => {
  serveOrder(status, message)
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const order = (await broker.getState()).orders[0]
  if (!order) throw new Error('Expected the broker order')
  expect(order.status).toBe(status)
  expect(order.message).toBe(message)
  expect(order.metadata?.requiresTwsAttention).toBeUndefined()
})

it.each(['stop', 'stop-limit', 'trailing-stop', 'trailing-stop-limit', 'limit'])(
  'explains accepted pre-submitted %s orders in both submission and subsequent state',
  async (type) => {
    serveOrder('pre-submitted', '')
    const state = await (await fetch('/fixture')).json()
    const order = { ...state.orders[0], type, message: undefined }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...state, orders: [order], order })),
    )
    const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
    const expected =
      type === 'limit'
        ? 'Accepted by broker; held until its activation conditions are met.'
        : 'Accepted by broker; waiting for stop trigger.'
    const result = await broker.placeOrder(
      {
        symbol: { ticker: 'AAPL', currency: 'USD', type: 'stock' },
        side: 'buy',
        type: 'stop',
        quantity: 1,
        stopPrice: 300,
        duration: { type: 'day' },
      },
      { symbol: { ticker: 'AAPL', currency: 'USD', type: 'stock' } },
    )
    expect(result.message).toBe(expected)
    expect(result.order?.status).toBe('pre-submitted')
    expect((await broker.getState()).orders[0]?.message).toBe(expected)
  },
)

it.each(['', '   '])(
  'explains pre-submitted orders with empty broker warning text %j',
  async (message) => {
    serveOrder('pre-submitted', message)
    const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
    expect((await broker.getState()).orders[0]?.message).toBe(
      'Accepted by broker; held until its activation conditions are met.',
    )
  },
)
