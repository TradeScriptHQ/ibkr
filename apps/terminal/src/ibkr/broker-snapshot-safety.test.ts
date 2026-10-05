import type { TradingEvent } from '@tradescript/pro/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter.js'
import type { BackendState } from './types.js'

const instrument = { symbol: 'TEST', currency: 'USD', assetClass: 'stock' }
const timestamp = '2026-09-30T10:00:00Z'
const current: BackendState = {
  connectionStatus: 'connected',
  activeAccountId: 'current',
  accounts: [{ id: 'current', label: 'Synthetic account', currency: 'USD' }],
  orders: [
    {
      id: 'current-order',
      accountId: 'current',
      symbol: instrument,
      side: 'buy',
      type: 'limit',
      duration: 'day',
      quantity: 1,
      limitPrice: 100,
      status: 'working',
      submittedAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  ordersHistory: [],
  positions: [{ id: 'current-position', accountId: 'current', symbol: instrument, quantity: 1 }],
  executions: [
    {
      id: 'current-fill',
      orderId: 'current-order',
      accountId: 'current',
      symbol: instrument,
      side: 'buy',
      quantity: 1,
      price: 100,
      timestamp,
    },
  ],
  quotes: [],
  messages: [],
  diagnostics: [],
  updatedAt: timestamp,
}
const obsolete: BackendState = {
  ...current,
  activeAccountId: 'obsolete',
  accounts: [],
  orders: [],
  positions: [],
  executions: [],
}

function sources() {
  const instances: TestEventSource[] = []
  class TestEventSource extends EventTarget {
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    close = vi.fn()
    constructor() {
      super()
      instances.push(this)
    }
    send(type: string, payload: unknown) {
      this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }))
    }
  }
  vi.stubGlobal('EventSource', TestEventSource)
  return instances
}
function deferredResponse() {
  let resolve: ((response: Response) => void) | undefined
  const promise = new Promise<Response>((complete) => {
    resolve = complete
  })
  return { promise, finish: (state: BackendState) => resolve?.(Response.json(state)) }
}
function adapterForTest() {
  const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const subscribe = adapter.subscribe
  const disconnect = adapter.disconnect
  if (!subscribe || !disconnect) throw new Error('Streaming lifecycle callbacks are required')
  return { ...adapter, subscribe, disconnect }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it.each([
  'state',
  'accounts',
  'orders',
  'orders-history',
  'positions',
  'executions',
  'connection-status',
] as const)('does not overwrite newer %s evidence with an earlier HTTP snapshot', async (type) => {
  vi.useFakeTimers()
  const instances = sources()
  const pending = deferredResponse()
  const fetch = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockImplementation(async () => Response.json(current))
  vi.stubGlobal('fetch', fetch)
  const adapter = adapterForTest()
  const received: TradingEvent[] = []
  const stop = adapter.subscribe((event) => received.push(event))
  const source = instances[0]
  source?.onopen?.()
  source?.send(type, {
    type,
    state: current,
    accounts: current.accounts,
    activeAccountId: current.activeAccountId,
    orders: current.orders,
    positions: current.positions,
    executions: current.executions,
    status: 'connected',
    timestamp,
  })
  pending.finish(obsolete)
  await vi.advanceTimersByTimeAsync(500)
  expect(
    received.filter(
      (event) => event.type === 'state' && event.state.activeAccountId === 'obsolete',
    ),
  ).toEqual([])
  expect(received.filter((event) => event.type === 'state').at(-1)).toMatchObject({
    state: {
      activeAccountId: 'current',
      orders: [{ id: 'current-order' }],
      positions: [{ id: 'current-position' }],
      executions: [{ id: 'current-fill' }],
    },
  })
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(2)
  stop()
})

it.each(['unsubscribe', 'disconnect'] as const)(
  'ignores a snapshot after %s closes its source',
  async (action) => {
    vi.useFakeTimers()
    const instances = sources()
    const pending = deferredResponse()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise))
    const adapter = adapterForTest()
    const received: TradingEvent[] = []
    const stop = adapter.subscribe((event) => received.push(event))
    instances[0]?.onopen?.()
    if (action === 'disconnect') await adapter.disconnect()
    else {
      stop()
      adapter.subscribe((event) => received.push(event))
    }
    pending.finish(obsolete)
    await vi.advanceTimersByTimeAsync(500)
    expect(received).toEqual([])
    stop()
    await adapter.disconnect()
  },
)

it('coalesces repeated source opens and discards the snapshot from the earlier open', async () => {
  vi.useFakeTimers()
  const instances = sources()
  const pending = deferredResponse()
  const fetch = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockImplementation(async () => Response.json(current))
  vi.stubGlobal('fetch', fetch)
  const adapter = adapterForTest()
  const received: TradingEvent[] = []
  const stop = adapter.subscribe((event) => received.push(event))
  instances[0]?.onopen?.()
  instances[0]?.onopen?.()
  instances[0]?.onopen?.()
  expect(fetch).toHaveBeenCalledTimes(1)
  pending.finish(obsolete)
  await vi.advanceTimersByTimeAsync(500)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(received).toMatchObject([{ type: 'state', state: { activeAccountId: 'current' } }])
  stop()
})

it('returns the current cached positions when an explicit state read overlaps a position update', async () => {
  const instances = sources()
  const pending = deferredResponse()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce(Response.json(current)).mockReturnValueOnce(pending.promise),
  )
  const adapter = adapterForTest()
  await adapter.getState()
  const stop = adapter.subscribe(() => undefined)
  const reading = adapter.getState()
  instances[0]?.send('positions', {
    type: 'positions',
    positions: [{ ...current.positions[0], quantity: 3 }],
    timestamp,
  })
  pending.finish(obsolete)
  expect((await reading).positions[0]?.quantity).toBe(3)
  stop()
})

it('refuses a state read whose connection was disposed while the response was pending', async () => {
  const pending = deferredResponse()
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending.promise))
  const adapter = adapterForTest()
  const reading = adapter.getState()
  await adapter.disconnect()
  pending.finish(obsolete)
  await expect(reading).rejects.toThrow(/connection.*changed/i)
})

it('does not confirm cancellation from an older snapshot after a newer fill is streamed', async () => {
  vi.useFakeTimers()
  const instances = sources()
  const pending = deferredResponse()
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(current))
    .mockResolvedValueOnce(Response.json({ accepted: true }))
    .mockReturnValueOnce(pending.promise)
  vi.stubGlobal('fetch', fetch)
  const adapter = adapterForTest()
  await adapter.getState()
  const stop = adapter.subscribe(() => undefined)
  const cancelOrder = adapter.cancelOrder
  if (!cancelOrder) throw new Error('Order cancellation is required')
  const currentOrder = current.orders[0]
  if (!currentOrder) throw new Error('Current order is required')
  const cancelling = cancelOrder('current-order', {
    symbol: { ticker: 'TEST', currency: 'USD', type: 'stock' },
    accountId: 'current',
  })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
  instances[0]?.send('orders', {
    type: 'orders',
    orders: [{ ...currentOrder, status: 'filled', filledQuantity: 1, remainingQuantity: 0 }],
    timestamp,
  })
  pending.finish({ ...current, orders: [{ ...currentOrder, status: 'cancelled' }] })
  await expect(cancelling).rejects.toMatchObject({ code: 'CANCEL_NOT_CONFIRMED' })
  stop()
})
