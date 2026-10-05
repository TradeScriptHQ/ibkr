import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { afterEach, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBrokerRuntime } from '../src/connections/broker-runtime.js'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function startupApi() {
  const api = Object.assign(new EventEmitter(), {
    isConnected: false,
    connect: vi.fn(() => {
      api.isConnected = true
    }),
    disconnect: vi.fn(() => {
      api.isConnected = false
      api.emit(EventName.disconnected)
    }),
    reqManagedAccts: vi.fn(),
    reqIds: vi.fn(),
    reqAccountSummary: vi.fn(),
    cancelAccountSummary: vi.fn(),
    reqPositions: vi.fn(),
    reqAllOpenOrders: vi.fn(),
    reqCompletedOrders: vi.fn(),
    reqExecutions: vi.fn(),
    reqMarketDataType: vi.fn(),
    reqAccountUpdates: vi.fn(),
    reqPnL: vi.fn(),
  })
  return api
}

it('tests managed accounts using the same starting transport without another connect', async () => {
  vi.useFakeTimers()
  const api = startupApi()
  const runtime = createBrokerRuntime(
    loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU-TEST' }),
    vi.fn(),
    api as unknown as IBApi,
  )
  try {
    runtime.start()
    const first = runtime.testConnection()
    const second = runtime.testConnection()
    expect(api.connect).toHaveBeenCalledOnce()
    api.emit(EventName.connected)
    api.emit(EventName.managedAccounts, 'DU-TEST')
    await expect(first).resolves.toEqual(['DU-TEST'])
    await expect(second).resolves.toEqual(['DU-TEST'])
    expect(api.connect).toHaveBeenCalledOnce()
  } finally {
    await runtime.stop()
  }
})

it('does not finish stopping until its transport reports disconnected', async () => {
  vi.useFakeTimers()
  const api = startupApi()
  api.disconnect.mockImplementation(() => {})
  const runtime = createBrokerRuntime(
    loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU-TEST' }),
    vi.fn(),
    api as unknown as IBApi,
  )
  runtime.start()
  api.emit(EventName.connected)
  let stopped = false
  const stopping = Promise.resolve(runtime.stop()).then(() => {
    stopped = true
  })
  try {
    await Promise.resolve()
    expect(api.disconnect).toHaveBeenCalledOnce()
    expect(stopped).toBe(false)
    api.isConnected = false
    api.emit(EventName.disconnected)
    await stopping
    expect(stopped).toBe(true)
  } finally {
    api.isConnected = false
    api.emit(EventName.disconnected)
    await Promise.allSettled([stopping])
  }
})

it('reconciles once per connection while feature services consume the same account and order events', () => {
  vi.useFakeTimers()
  const api = Object.assign(new EventEmitter(), {
    isConnected: false,
    connect: vi.fn(() => {
      api.isConnected = true
    }),
    disconnect: vi.fn(() => {
      api.isConnected = false
      api.emit(EventName.disconnected)
    }),
    reqManagedAccts: vi.fn(),
    reqAccountSummary: vi.fn(),
    cancelAccountSummary: vi.fn(),
    reqPositions: vi.fn(),
    reqAllOpenOrders: vi.fn(),
    reqOpenOrders: vi.fn(),
    reqCompletedOrders: vi.fn(),
    reqExecutions: vi.fn(),
    reqIds: vi.fn(),
    reqMarketDataType: vi.fn(),
    reqAccountUpdates: vi.fn(),
    reqPnL: vi.fn(),
  })
  const runtime = createBrokerRuntime(
    loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU-TEST' }),
    vi.fn(),
    api as unknown as IBApi,
  )
  try {
    runtime.start()
    runtime.start()
    expect(api.connect).toHaveBeenCalledOnce()
    for (let generation = 1; generation <= 2; generation++) {
      api.emit(EventName.connected)
      // A socket alone must not launch another, parallel reconciliation.
      expect(api.reqPositions).toHaveBeenCalledTimes(generation - 1)
      api.emit(EventName.managedAccounts, 'DU-TEST')
      api.emit(EventName.nextValidId, 100 * generation)
      api.emit(EventName.nextValidId, 100 * generation + 1)
      expect(api.reqPositions).toHaveBeenCalledTimes(generation)
      expect(api.reqAccountSummary).toHaveBeenCalledTimes(generation)
      expect(api.reqExecutions).toHaveBeenCalledTimes(generation)
      expect(api.reqAllOpenOrders).toHaveBeenCalledTimes(generation)
      expect(api.reqOpenOrders).not.toHaveBeenCalled()
      const accountRequestId = api.reqAccountSummary.mock.calls.at(-1)?.[0]
      const executionRequestId = api.reqExecutions.mock.calls.at(-1)?.[0]
      api.emit(
        EventName.accountSummary,
        accountRequestId,
        'DU-TEST',
        'NetLiquidation',
        '10000',
        'USD',
      )
      api.emit(EventName.accountSummaryEnd, accountRequestId)
      api.emit(EventName.positionEnd)
      api.emit(EventName.openOrderEnd)
      api.emit(EventName.completedOrdersEnd)
      api.emit(EventName.execDetailsEnd, executionRequestId)
      expect(runtime.tws.snapshot().state).toBe('ready')
      expect(runtime.brokerStore.getState().accounts[0]?.netLiquidation).toBe(10000)
      const orderId = runtime.tws.allocateOrderId()
      expect(orderId).toBeGreaterThanOrEqual(100 * generation + 1)
      expect([accountRequestId, executionRequestId]).not.toContain(orderId)
      if (generation === 1) {
        api.isConnected = false
        api.emit(EventName.disconnected)
      }
    }
  } finally {
    runtime.stop()
  }
  const connects = api.connect.mock.calls.length
  vi.advanceTimersByTime(60_000)
  expect(api.connect).toHaveBeenCalledTimes(connects)
})

it('marks absent orders unknown only after all reconnect snapshots finish, without inventing cancellations', () => {
  vi.useFakeTimers()
  const api = Object.assign(new EventEmitter(), {
    isConnected: false,
    connect: vi.fn(() => {
      api.isConnected = true
    }),
    disconnect: vi.fn(() => {
      api.isConnected = false
      api.emit(EventName.disconnected)
    }),
    reqManagedAccts: vi.fn(),
    reqAccountSummary: vi.fn(),
    cancelAccountSummary: vi.fn(),
    reqPositions: vi.fn(),
    reqAllOpenOrders: vi.fn(),
    reqCompletedOrders: vi.fn(),
    reqExecutions: vi.fn(),
    reqIds: vi.fn(),
    reqMarketDataType: vi.fn(),
    reqAccountUpdates: vi.fn(),
    reqPnL: vi.fn(),
    cancelOrder: vi.fn(),
    placeOrder: vi.fn(),
  })
  const runtime = createBrokerRuntime(
    loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU-TEST' }),
    vi.fn(),
    api as unknown as IBApi,
  )
  const contract = {
    conId: 123,
    symbol: 'AAPL',
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
  }
  const order = {
    account: 'DU-TEST',
    clientId: 0,
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 1,
    lmtPrice: 100,
  }
  const reconcile = (nextId: number) => {
    api.emit(EventName.connected)
    api.emit(EventName.managedAccounts, 'DU-TEST')
    api.emit(EventName.nextValidId, nextId)
  }
  const finish = () => {
    api.emit(EventName.accountSummaryEnd, api.reqAccountSummary.mock.calls.at(-1)?.[0])
    api.emit(EventName.positionEnd)
    api.emit(EventName.openOrderEnd)
    api.emit(EventName.completedOrdersEnd)
    api.emit(EventName.execDetailsEnd, api.reqExecutions.mock.calls.at(-1)?.[0])
  }
  try {
    runtime.start()
    reconcile(10)
    api.emit(EventName.openOrder, 40, contract, { ...order, permId: 400 }, { status: 'Submitted' })
    api.emit(EventName.openOrder, 50, contract, { ...order, permId: 500 }, { status: 'Submitted' })
    finish()
    expect(runtime.brokerStore.getState().orders.map((o) => o.status)).toEqual([
      'working',
      'working',
    ])
    api.isConnected = false
    api.emit(EventName.disconnected)
    reconcile(100)
    api.emit(EventName.openOrder, 40, contract, { ...order, permId: 400 }, { status: 'Submitted' })
    api.emit(EventName.openOrderEnd)
    expect(runtime.brokerStore.getState().orders.find((o) => o.id === '50')?.status).toBe('working')
    finish()
    expect(runtime.tws.snapshot().state).toBe('ready')
    expect(runtime.brokerStore.getState().orders.find((o) => o.id === '40')?.status).toBe('working')
    expect(runtime.brokerStore.getState().orders.find((o) => o.id === '50')).toMatchObject({
      status: 'inactive',
      customFields: { ibkrMissingOpenOrder: true },
    })
    expect(() => runtime.ibkr.cancelOrder('50')).toThrow('not bound')
    expect(api.cancelOrder).not.toHaveBeenCalled()
    expect(api.placeOrder).not.toHaveBeenCalled()
    const socketGeneration = runtime.tws.snapshot().generation
    api.emit(EventName.error, new Error('Provider connectivity lost'), 1100, -1)
    api.emit(EventName.error, new Error('Provider connectivity restored'), 1101, -1)
    api.emit(EventName.nextValidId, 200)
    finish()
    expect(runtime.tws.snapshot().generation).toBe(socketGeneration)
    expect(runtime.brokerStore.getState().orders.find((o) => o.id === '40')).toMatchObject({
      status: 'inactive',
      customFields: { ibkrMissingOpenOrder: true },
    })
  } finally {
    runtime.stop()
  }
})
