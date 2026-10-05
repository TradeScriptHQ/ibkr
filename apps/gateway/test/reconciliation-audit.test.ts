import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBrokerRuntime } from '../src/connections/broker-runtime.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { Order } from '../src/ibkr/types.js'

const contract = { conId: 100, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' }
const wireOrder = {
  account: 'DU123',
  clientId: 0,
  permId: 700,
  action: 'BUY',
  orderType: 'LMT',
  tif: 'DAY',
  totalQuantity: 2,
  lmtPrice: 150,
}
const baseOrder: Order = {
  id: '25',
  brokerOrderId: 25,
  permId: 700,
  clientId: 0,
  accountId: 'DU123',
  symbol: { symbol: 'AAPL', assetClass: 'stock', exchange: 'SMART', currency: 'USD' },
  side: 'buy',
  type: 'limit',
  duration: 'day',
  quantity: 2,
  limitPrice: 150,
  status: 'working',
  submittedAt: '2026-09-30T12:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
}

function apiFixture() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'))
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
    reqAutoOpenOrders: vi.fn(),
    reqCompletedOrders: vi.fn(),
    reqExecutions: vi.fn(),
    reqIds: vi.fn(),
    reqMarketDataType: vi.fn(),
    reqAccountUpdates: vi.fn(),
    reqPnL: vi.fn(),
    cancelOrder: vi.fn(),
    placeOrder: vi.fn(),
  })
  return api
}

function fixture() {
  const api = apiFixture()
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU123' })),
    store,
    api as unknown as IBApi,
  )
  return { api, store, service }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('independent reconciliation audit', () => {
  it('does not resurrect a fully filled order on a delayed Inactive open-order snapshot', () => {
    const { api, store } = fixture()
    store.upsertOrder({ ...baseOrder, status: 'filled', filledQuantity: 2, remainingQuantity: 0 })
    api.emit(EventName.openOrder, 25, contract, wireOrder, { status: 'Inactive' })
    expect(store.getState().orders).toEqual([])
    expect(store.getState().ordersHistory?.[0]?.status).toBe('filled')
  })

  it('does not relabel a fully filled order as cancelled on a delayed order-status callback', () => {
    const { api, store } = fixture()
    store.upsertOrder({ ...baseOrder, status: 'filled', filledQuantity: 2, remainingQuantity: 0 })
    api.emit(EventName.orderStatus, 25, 'Cancelled', 0, 0, 0, 700, 0, 0, 0)
    expect(store.getState().ordersHistory?.[0]?.status).toBe('filled')
  })

  it('retains the complete fill average when an older lower-fill callback arrives', () => {
    const { api, store } = fixture()
    store.upsertOrder({
      ...baseOrder,
      status: 'filled',
      filledQuantity: 2,
      remainingQuantity: 0,
      avgFillPrice: 151,
    })
    api.emit(EventName.orderStatus, 25, 'Submitted', 1, 1, 150, 700, 0, 150, 0)
    expect(store.getState().ordersHistory?.[0]).toMatchObject({
      status: 'filled',
      filledQuantity: 2,
      avgFillPrice: 151,
    })
  })

  it('retains the complete fill average when an older lower-cumulative execution arrives', () => {
    const { api, store } = fixture()
    store.upsertOrder({
      ...baseOrder,
      status: 'filled',
      filledQuantity: 2,
      remainingQuantity: 0,
      avgFillPrice: 151,
    })
    api.emit(EventName.execDetails, 0, contract, {
      orderId: 25,
      acctNumber: 'DU123',
      permId: 700,
      clientId: 0,
      execId: 'older-fill.01',
      side: 'BOT',
      shares: 1,
      cumQty: 1,
      price: 150,
      avgPrice: 150,
      time: '20260930 12:00:01 UTC',
    })
    expect(store.getState().ordersHistory?.[0]).toMatchObject({
      status: 'filled',
      filledQuantity: 2,
      avgFillPrice: 151,
    })
  })

  it('keeps a genuine fill authoritative after a previous partial cancellation', () => {
    const { api, store } = fixture()
    store.upsertOrder({
      ...baseOrder,
      status: 'cancelled',
      filledQuantity: 1,
      remainingQuantity: 0,
    })
    api.emit(EventName.orderStatus, 25, 'Filled', 2, 0, 151, 700, 0, 151, 0)
    expect(store.getState().ordersHistory?.[0]).toMatchObject({
      status: 'filled',
      filledQuantity: 2,
      remainingQuantity: 0,
      avgFillPrice: 151,
    })
  })

  it('retains a full fill when completed-order readback reports a stale cancellation', () => {
    const { api, store } = fixture()
    store.upsertOrder({ ...baseOrder, status: 'filled', filledQuantity: 2, remainingQuantity: 0 })
    api.emit(EventName.completedOrder, contract, wireOrder, {
      status: 'Cancelled',
      completedStatus: 'Cancelled',
    })
    expect(store.getState().ordersHistory?.[0]).toMatchObject({
      id: '25',
      status: 'filled',
      filledQuantity: 2,
      remainingQuantity: 0,
    })
  })

  it('does not resurrect a terminal order when completed-order status is unrecognized', () => {
    const { api, store } = fixture()
    store.upsertOrder({
      ...baseOrder,
      status: 'cancelled',
      filledQuantity: 1,
      remainingQuantity: 0,
    })
    api.emit(EventName.completedOrder, contract, wireOrder, { completedStatus: 'Unknown' })
    expect(store.getState().orders).toEqual([])
    expect(store.getState().ordersHistory?.[0]?.status).toBe('cancelled')
  })

  it('cancels an owned manual order after orderBound assigns a negative API order ID', () => {
    const { api, store, service } = fixture()
    api.emit(EventName.openOrder, 0, contract, wireOrder, { status: 'Submitted' })
    api.emit(EventName.orderBound, 700, 0, -2)
    expect(store.getState().orders[0]).toMatchObject({ id: 'perm:700', brokerOrderId: -2 })
    service.cancelOrder('perm:700')
    expect(api.cancelOrder).toHaveBeenCalledExactlyOnceWith(-2)
  })

  it('retains the owned negative API ID returned in manual-order readback', () => {
    const { api, store, service } = fixture()
    api.emit(EventName.openOrder, -2, contract, wireOrder, { status: 'Submitted' })
    expect(store.getState().orders[0]).toMatchObject({ id: 'perm:700', brokerOrderId: -2 })
    service.cancelOrder('perm:700')
    expect(api.cancelOrder).toHaveBeenCalledExactlyOnceWith(-2)
  })

  it('does not attach an unscoped farm warning to a manual order bound as negative one', () => {
    const { api, store } = fixture()
    store.upsertOrder({ ...baseOrder, id: 'perm:700', brokerOrderId: -1 })
    api.emit(EventName.error, new Error('Sec-def data farm connection is OK'), 2158, -1)
    expect(store.getState().orders[0]).toMatchObject({ status: 'working' })
    expect(store.getState().orders[0]?.message).toBeUndefined()
  })

  it('attaches an explicit cancellation confirmation to an owned negative API ID', () => {
    const { api, store } = fixture()
    store.upsertOrder({ ...baseOrder, id: 'perm:700', brokerOrderId: -1 })
    api.emit(EventName.error, new Error('Order cancelled'), 202, -1)
    expect(store.getState().ordersHistory?.[0]).toMatchObject({
      id: 'perm:700',
      status: 'cancelled',
    })
  })

  it('does not cancel a negative API ID owned by another client', () => {
    const { api, store, service } = fixture()
    store.upsertOrder({ ...baseOrder, id: 'perm:700', brokerOrderId: -2, clientId: 2 })
    expect(() => service.cancelOrder('perm:700')).toThrow(/not bound/i)
    expect(api.cancelOrder).not.toHaveBeenCalled()
  })

  it('marks an absent inactive order unconfirmed and prevents cancellation by its stale API ID', () => {
    const { api, store, service } = fixture()
    store.upsertOrder({ ...baseOrder, status: 'inactive' })
    service.finishOrderReconciliation()
    expect(store.getState().orders[0]?.customFields?.ibkrMissingOpenOrder).toBe(true)
    expect(() => service.cancelOrder('25')).toThrow(/not bound/i)
    expect(api.cancelOrder).not.toHaveBeenCalled()
  })

  it('does not combine fill quantities across two clients with the same API order ID', () => {
    const { api, store } = fixture()
    api.emit(EventName.openOrder, 25, contract, wireOrder, { status: 'Submitted' })
    api.emit(
      EventName.openOrder,
      25,
      contract,
      { ...wireOrder, permId: 701, clientId: 2 },
      { status: 'Submitted' },
    )
    const fill = {
      orderId: 25,
      acctNumber: 'DU123',
      side: 'BOT',
      shares: 1,
      price: 150,
      time: '20260930 12:00:01 UTC',
    }
    api.emit(EventName.execDetails, 0, contract, {
      ...fill,
      execId: 'own-fill.01',
      permId: 700,
      clientId: 0,
    })
    api.emit(EventName.execDetails, 0, contract, {
      ...fill,
      execId: 'other-fill.01',
      permId: 701,
      clientId: 2,
    })
    expect(store.getState().orders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: '25', status: 'partially-filled', filledQuantity: 1 }),
        expect.objectContaining({ id: 'perm:701', status: 'partially-filled', filledQuantity: 1 }),
      ]),
    )
    expect(store.getState().ordersHistory).toEqual([])
  })

  it('reconciles an absent order after connectivity recovery on the same socket generation', () => {
    const api = apiFixture()
    const runtime = createBrokerRuntime(
      loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU123' }),
      vi.fn(),
      api as unknown as IBApi,
    )
    const finish = () => {
      api.emit(EventName.accountSummaryEnd, api.reqAccountSummary.mock.calls.at(-1)?.[0])
      api.emit(EventName.positionEnd)
      api.emit(EventName.openOrderEnd)
      api.emit(EventName.completedOrdersEnd)
      api.emit(EventName.execDetailsEnd, api.reqExecutions.mock.calls.at(-1)?.[0])
    }
    try {
      runtime.start()
      api.emit(EventName.connected)
      api.emit(EventName.managedAccounts, 'DU123')
      api.emit(EventName.nextValidId, 100)
      api.emit(EventName.openOrder, 25, contract, wireOrder, { status: 'Submitted' })
      finish()
      expect(runtime.tws.snapshot().state).toBe('ready')
      const generation = runtime.tws.snapshot().generation
      api.emit(EventName.error, new Error('Connection lost'), 1100, -1)
      api.emit(EventName.error, new Error('Connectivity restored'), 1102, -1)
      api.emit(EventName.nextValidId, 101)
      finish()
      expect(runtime.tws.snapshot().state).toBe('ready')
      expect(runtime.tws.snapshot().generation).toBe(generation)
      expect(runtime.brokerStore.getState().orders[0]).toMatchObject({
        status: 'inactive',
        customFields: { ibkrMissingOpenOrder: true },
      })
      expect(() => runtime.ibkr.cancelOrder('25')).toThrow(/not bound/i)
      expect(api.cancelOrder).not.toHaveBeenCalled()
    } finally {
      runtime.stop()
    }
  })
})
