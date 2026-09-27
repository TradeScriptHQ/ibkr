import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { afterEach, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBrokerRuntime } from '../src/connections/broker-runtime.js'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
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
      api.emit(EventName.accountSummary, 900_001, 'DU-TEST', 'NetLiquidation', '10000', 'USD')
      api.emit(EventName.accountSummaryEnd, 900_001)
      api.emit(EventName.positionEnd)
      api.emit(EventName.openOrderEnd)
      api.emit(EventName.completedOrdersEnd)
      api.emit(EventName.execDetailsEnd, 900_002)
      expect(runtime.tws.snapshot().state).toBe('ready')
      expect(runtime.brokerStore.getState().accounts[0]?.netLiquidation).toBe(10000)
      expect(runtime.tws.allocateOrderId()).toBe(100 * generation + 1)
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
