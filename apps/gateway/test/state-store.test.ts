import { describe, expect, it } from 'vitest'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { Execution, Order } from '../src/ibkr/types.js'

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

const execution: Execution = {
  id: 'synthetic-fill.01.01',
  accountId: 'DU123',
  orderId: '1400',
  symbol: { symbol: 'AAPL', assetClass: 'stock', exchange: 'SMART', currency: 'USD' },
  side: 'buy',
  quantity: 1,
  price: 150,
  timestamp: '2026-09-30T14:30:00.000Z',
}

describe('execution replay timestamps', () => {
  it.each(['', 'invalid'])(
    'keeps a known broker time on exact-ID replay with %j time',
    (timestamp) => {
      const store = new BrokerStateStore()
      store.upsertExecution(execution)
      store.upsertExecution({ ...execution, timestamp, price: 151 })
      expect(store.getState().executions).toEqual([{ ...execution, price: 151 }])
    },
  )

  it('retains the known fill time when a corrected revision has no parseable broker time', () => {
    const store = new BrokerStateStore()
    store.setExecutions([
      execution,
      { ...execution, id: 'synthetic-fill.01.02', timestamp: '', price: 152 },
    ])
    expect(store.getState().executions).toEqual([
      { ...execution, id: 'synthetic-fill.01.02', price: 152 },
    ])
  })

  it('does not let a stale revision change corrected fields or timestamp', () => {
    const store = new BrokerStateStore()
    const corrected = { ...execution, id: 'synthetic-fill.01.02', price: 152 }
    store.upsertExecution(corrected)
    expect(store.upsertExecution({ ...execution, timestamp: '2026-09-30T15:00:00.000Z' })).toBe(
      false,
    )
    expect(store.getState().executions).toEqual([corrected])
  })

  it('accepts a known corrected broker timestamp in place of an unknown earlier timestamp', () => {
    const store = new BrokerStateStore()
    store.upsertExecution({ ...execution, timestamp: '' })
    const corrected = {
      ...execution,
      id: 'synthetic-fill.01.02',
      timestamp: '2026-09-30T14:31:00.000Z',
    }
    store.upsertExecution(corrected)
    expect(store.getState().executions).toEqual([corrected])
  })

  it.each([{ accountId: 'DU999' }, { orderId: '1401' }])(
    'never borrows a timestamp across a different execution owner %j',
    (owner) => {
      const store = new BrokerStateStore()
      store.upsertExecution(execution)
      const unrelated = { ...execution, ...owner, id: 'synthetic-fill.01.02', timestamp: '' }
      store.upsertExecution(unrelated)
      expect(store.getState().executions).toEqual([execution, unrelated])
    },
  )
})

describe('broker state market depth', () => {
  it('keeps depth reads current but publishes one settled book per event-loop turn', async () => {
    const store = new BrokerStateStore()
    const events: Array<{ type: string; marketDepth?: { bids: Array<{ price: number }> } }> = []
    store.subscribe((event) => events.push(event as (typeof events)[number]))
    events.length = 0
    const symbol = { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' }
    const book = (bids: number[]) => ({
      streamId: 'depth:AAPL',
      symbol,
      bids: bids.map((price) => ({ price, size: 100 })),
      asks: [{ price: 251, size: 100 }],
      updatedAt: new Date().toISOString(),
    })

    // A top-of-book change arrives as delete then insert at the same position.
    store.setMarketDepth(book([250, 249.9]))
    store.setMarketDepth(book([249.9]))
    store.setMarketDepth(book([250.05, 249.9]))
    expect(store.marketDepth('depth:AAPL')?.bids.map((level) => level.price)).toEqual([
      250.05, 249.9,
    ])
    expect(events).toEqual([])

    await new Promise((resolve) => setImmediate(resolve))
    expect(events.map((event) => event.type)).toEqual(['market-depth'])
    expect(events[0]?.marketDepth?.bids.map((level) => level.price)).toEqual([250.05, 249.9])
  })
})
