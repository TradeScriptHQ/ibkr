import { describe, expect, it } from 'vitest'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { Order } from '../src/ibkr/types.js'

function order(status: Order['status']): Order {
  return {
    id: 'qualification-order',
    symbol: { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
    side: 'buy',
    type: 'limit',
    duration: 'day',
    quantity: 1,
    limitPrice: 300,
    status,
    submittedAt: '2026-08-27T19:00:00.000Z',
    updatedAt: '2026-08-27T19:00:00.000Z',
  }
}

describe('broker state order lifecycle', () => {
  it('moves terminal orders out of the working set and into history', () => {
    const store = new BrokerStateStore()

    store.upsertOrder(order('working'))
    expect(store.getState().orders).toHaveLength(1)
    expect(store.getState().ordersHistory).toHaveLength(0)

    store.upsertOrder(order('cancelled'))
    expect(store.getState().orders).toHaveLength(0)
    expect(store.getState().ordersHistory).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ])
  })

  it('splits a reconciled broker snapshot into open orders and history', () => {
    const store = new BrokerStateStore()
    store.setOrders([order('working'), { ...order('filled'), id: 'filled-order' }])

    expect(store.getState().orders.map((item) => item.id)).toEqual(['qualification-order'])
    expect(store.getState().ordersHistory?.map((item) => item.id)).toEqual(['filled-order'])
  })
})
