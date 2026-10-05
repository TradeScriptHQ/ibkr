import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { Order } from '../src/ibkr/types.js'

const locateMessage =
  'Shares for this order are not immediately available for short sale. The order will be held while we attempt to locate the shares.'
function fixture(status: Order['status']) {
  const api = Object.assign(new EventEmitter(), { reqAllOpenOrders: vi.fn() })
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU-TEST' })),
    store,
    api as unknown as IBApi,
  )
  store.upsertOrder({
    id: '51',
    brokerOrderId: 51,
    accountId: 'DU-TEST',
    symbol: { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
    side: 'sell',
    type: 'limit',
    duration: 'day',
    quantity: 1,
    limitPrice: 100,
    status,
    submittedAt: '2026-09-30T10:00:00Z',
    updatedAt: '2026-09-30T10:00:00Z',
  })
  return { api, store }
}

describe('short-sale shares locate hold', () => {
  it.each(['placing', 'working'] as const)(
    'keeps %s orders active until broker readback after 404',
    (status) => {
      const { api, store } = fixture(status)
      api.emit(EventName.error, new Error(locateMessage), 404, 51)
      expect(store.getState().orders[0]).toMatchObject({
        status,
        message: expect.stringContaining('held'),
      })
      expect(store.getState().ordersHistory).toEqual([])
      expect(api.reqAllOpenOrders).toHaveBeenCalledExactlyOnceWith()
      api.emit(EventName.orderStatus, 51, 'Submitted', 0, 1, 0)
      expect(store.getState().orders[0]?.status).toBe('working')
    },
  )
  it('does not revive a filled order on a late held notification', () => {
    const { api, store } = fixture('filled')
    api.emit(EventName.error, new Error(locateMessage), 404, 51)
    expect(store.getState().orders).toEqual([])
    expect(store.getState().ordersHistory?.[0]?.status).toBe('filled')
  })
  it('continues to reject an unacknowledged order on definitive 201', () => {
    const { api, store } = fixture('placing')
    api.emit(EventName.error, new Error('Order rejected - account restriction'), 201, 51)
    expect(store.getState().orders).toEqual([])
    expect(store.getState().ordersHistory?.[0]?.status).toBe('rejected')
  })
})
