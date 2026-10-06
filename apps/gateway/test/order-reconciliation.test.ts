import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { afterEach, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { Order } from '../src/ibkr/types.js'

const baseOrder: Order = {
  id: '1316',
  brokerOrderId: 1316,
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
  quantity: 1,
  limitPrice: 314.1,
  status: 'working',
  submittedAt: '2026-09-09T17:18:13.093Z',
  updatedAt: '2026-09-09T17:18:13.460Z',
}

function fixture() {
  vi.useFakeTimers()
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const ib = Object.assign(new EventEmitter(), {
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    reqIds: vi.fn(),
  })
  new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU123' })),
    store,
    ib as unknown as IBApi,
  )
  return { ib, store }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it.each([
  [EventName.openOrder, { auxPrice: 0.5 }],
  [EventName.openOrder, { trailingPercent: 2 }],
  [EventName.completedOrder, { auxPrice: 0.5 }],
  [EventName.completedOrder, { trailingPercent: 2 }],
])('clears old guessed pip distance on authoritative %s trailing readback %j', (event, trail) => {
  const { ib, store } = fixture()
  store.upsertOrder({ ...baseOrder, type: 'trailing-stop', trailingStopPips: 50 })
  const contract = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' }
  const order = {
    orderId: 1316,
    account: 'DU123',
    action: 'BUY',
    orderType: 'TRAIL',
    totalQuantity: 1,
    ...trail,
  }
  if (event === EventName.openOrder) ib.emit(event, 1316, contract, order, { status: 'Submitted' })
  else ib.emit(event, contract, order, { status: 'Filled', completedStatus: 'Filled' })
  const state = store.getState()
  const restored = [...state.orders, ...(state.ordersHistory ?? [])].find(
    (item) => item.id === '1316',
  )
  expect(restored).toBeDefined()
  expect(restored?.trailingStopPips).toBeUndefined()
  if ('auxPrice' in trail) expect(restored?.customFields?.ibkrTrailingAmount).toBe(0.5)
  else expect(restored?.trailPercent).toBe(2)
})

it('retains a filled bracket leg and applies a later detailed order status in History', () => {
  const { ib, store } = fixture()
  store.upsertOrder(baseOrder)

  const contract = {
    symbol: 'AAPL',
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
  }
  const order = {
    account: 'DU123',
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 1,
    lmtPrice: 314.1,
  }

  // TWS emitted this sequence for the affected bracket parents: the terminal
  // open-order snapshot arrived before the callback containing fill details.
  ib.emit(EventName.openOrder, 1316, contract, order, { status: 'Filled' })
  ib.emit(EventName.orderStatus, 1316, 'Filled', 1, 0, 311.7)
  ib.emit(EventName.openOrder, 1316, contract, order, { status: 'Filled' })

  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory).toHaveLength(1)
  expect(store.getState().ordersHistory?.[0]).toMatchObject({
    id: '1316',
    status: 'filled',
    quantity: 1,
    filledQuantity: 1,
    remainingQuantity: 0,
    avgFillPrice: 311.7,
  })
})

it('restores completed-order callbacks into History during session reconciliation', () => {
  const { ib, store } = fixture()

  ib.emit(
    EventName.completedOrder,
    { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    {
      orderId: 1316,
      account: 'DU123',
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: 2,
      lmtPrice: 314.1,
    },
    { status: 'Filled', completedStatus: 'Filled' },
  )

  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory?.[0]).toMatchObject({
    id: '1316',
    status: 'filled',
    quantity: 2,
    filledQuantity: 2,
    remainingQuantity: 0,
    customFields: { ibkrCompleted: true, ibkrCompletedStatus: 'Filled' },
  })
})

it('restores a completed order read back after a restart with its fill size and completion time', () => {
  const { ib, store } = fixture()
  vi.setSystemTime(new Date('2026-10-05T14:00:44Z'))
  // As IBKR reports it: no API order id, totalQuantity 0, and the size in filledQuantity.
  ib.emit(
    EventName.completedOrder,
    { symbol: 'MSFT', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    {
      orderId: 0,
      permId: 634477160,
      account: 'DU123',
      action: 'SELL',
      orderType: 'MKT',
      totalQuantity: 0,
      filledQuantity: 1,
    },
    {
      status: 'Filled',
      completedStatus: 'Filled Size: 1',
      completedTime: '20261005 09:30:16 US/Eastern',
    },
  )
  // The gateway then replays the day's executions, which supply the fill price.
  vi.setSystemTime(new Date('2026-10-05T14:00:45Z'))
  ib.emit(
    EventName.execDetails,
    0,
    { symbol: 'MSFT', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    {
      orderId: 0,
      permId: 634477160,
      execId: '0000dc8f.6bceba94.01.01',
      acctNumber: 'DU123',
      side: 'SLD',
      shares: 1,
      price: 523.39,
      cumQty: 1,
      avgPrice: 523.39,
      time: '20261005 09:30:16 US/Eastern',
    },
  )

  const restored = store.getState().ordersHistory?.[0]
  expect(restored).toMatchObject({
    status: 'filled',
    quantity: 1,
    filledQuantity: 1,
    avgFillPrice: 523.39,
    updatedAt: '2026-10-05T13:30:16.000Z',
  })
  expect(restored?.submittedAt).toBeUndefined()
})

it('reconciles a complete execution when IBKR omits the final order-status callback', () => {
  const { ib, store } = fixture()
  store.upsertOrder(baseOrder)

  ib.emit(
    EventName.execDetails,
    0,
    { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    {
      orderId: 1316,
      execId: '0000e0d5.60c6f0f6.01.01',
      acctNumber: 'DU123',
      side: 'BOT',
      shares: 1,
      price: 311.7,
      cumQty: 1,
      avgPrice: 311.7,
    },
  )

  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory?.[0]).toMatchObject({
    id: '1316',
    status: 'filled',
    filledQuantity: 1,
    remainingQuantity: 0,
    avgFillPrice: 311.7,
  })
  expect(store.getState().executions).toHaveLength(1)
})

it('does not reconcile an execution from another account with the same API order id', () => {
  const { ib, store } = fixture()
  store.upsertOrder(baseOrder)

  ib.emit(
    EventName.execDetails,
    0,
    { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    {
      orderId: 1316,
      execId: '0000e0d5.60c6f0f6.01.01',
      acctNumber: 'DU999',
      side: 'BOT',
      shares: 1,
      price: 311.7,
      cumQty: 1,
      avgPrice: 311.7,
    },
  )

  expect(store.getState().orders[0]).toMatchObject({ id: '1316', status: 'working' })
  expect(store.getState().orders[0]?.filledQuantity).toBeUndefined()
  expect(store.getState().ordersHistory).toEqual([])
  expect(store.getState().executions[0]?.accountId).toBe('DU999')
})

it('deduplicates execution replays and replaces corrected executions before totaling fills', () => {
  const { ib, store } = fixture()
  store.upsertOrder({ ...baseOrder, quantity: 2 })
  const contract = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' }
  const first = {
    orderId: 1316,
    execId: '0000e0d5.60c6f0f6.01.01',
    acctNumber: 'DU123',
    side: 'BOT',
    shares: 1,
    price: 310,
  }

  ib.emit(EventName.execDetails, 0, contract, first)
  ib.emit(EventName.execDetails, 0, contract, first)
  expect(store.getState().orders[0]).toMatchObject({
    status: 'partially-filled',
    filledQuantity: 1,
    remainingQuantity: 1,
    avgFillPrice: 310,
  })

  ib.emit(EventName.execDetails, 0, contract, {
    ...first,
    execId: '0000e0d5.60c6f0f6.01.02',
    price: 312,
  })
  expect(store.getState().executions).toHaveLength(1)
  expect(store.getState().orders[0]).toMatchObject({ filledQuantity: 1, avgFillPrice: 312 })
  ib.emit(EventName.execDetails, 0, contract, first)
  expect(store.getState().executions[0]).toMatchObject({
    id: '0000e0d5.60c6f0f6.01.02',
    price: 312,
  })
  expect(store.getState().orders[0]).toMatchObject({ filledQuantity: 1, avgFillPrice: 312 })

  ib.emit(EventName.execDetails, 0, contract, {
    ...first,
    execId: '0000e0d5.60c6f0f6.02.01',
    price: 314,
  })
  expect(store.getState().executions).toHaveLength(2)
  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory?.[0]).toMatchObject({
    status: 'filled',
    filledQuantity: 2,
    remainingQuantity: 0,
    avgFillPrice: 313,
  })
})

it('does not count individual combo-leg executions as parent-order fills', () => {
  const { ib, store } = fixture()
  const option = (strike: number, side: 'buy' | 'sell') => ({
    contract: {
      underlying: 'AAPL',
      underlyingSymbolInfo: baseOrder.symbol,
      expiration: '2026-10-16',
      strike,
      right: 'call' as const,
      multiplier: 100,
    },
    side,
    positionEffect: 'open' as const,
    quantity: 1,
  })
  store.upsertOrder({
    ...baseOrder,
    optionLegs: [option(300, 'buy'), option(310, 'sell')],
  })
  const execution = {
    orderId: 1316,
    acctNumber: 'DU123',
    side: 'BOT',
    shares: 1,
    cumQty: 1,
    price: 2,
    avgPrice: 2,
  }

  ib.emit(
    EventName.execDetails,
    0,
    { symbol: 'AAPL', secType: 'OPT', exchange: 'SMART', currency: 'USD' },
    { ...execution, execId: '0000e0d5.60c6f0f6.01.01' },
  )
  expect(store.getState().orders[0]).toMatchObject({ status: 'working' })
  expect(store.getState().orders[0]?.filledQuantity).toBeUndefined()

  ib.emit(
    EventName.execDetails,
    0,
    { symbol: 'AAPL', secType: 'BAG', exchange: 'SMART', currency: 'USD' },
    { ...execution, execId: '0000e0d5.60c6f0f6.02.01' },
  )
  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory?.[0]).toMatchObject({
    status: 'filled',
    filledQuantity: 1,
  })
})

it('keeps the original quantity when an OCO cancellation snapshot reports zero', () => {
  const { ib, store } = fixture()
  store.upsertOrder({
    ...baseOrder,
    id: '1317',
    brokerOrderId: 1317,
    side: 'sell',
    limitPrice: 315.78,
    parentId: '1316',
    parentType: 'order',
    bracketGroupId: '1316',
    ocaGroup: '1838090658',
  })

  const contract = {
    symbol: 'AAPL',
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
  }
  const cancelledChild = {
    account: 'DU123',
    action: 'SELL',
    orderType: 'LMT',
    totalQuantity: 0,
    lmtPrice: 315.78,
    parentId: 1316,
    ocaGroup: '1838090658',
  }

  ib.emit(EventName.openOrder, 1317, contract, cancelledChild, { status: 'PendingCancel' })
  ib.emit(EventName.orderStatus, 1317, 'Cancelled', 0, 0, 0)
  ib.emit(EventName.openOrder, 1317, contract, cancelledChild, { status: 'Cancelled' })

  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory?.[0]).toMatchObject({
    id: '1317',
    status: 'cancelled',
    quantity: 1,
    filledQuantity: 0,
    remainingQuantity: 0,
    parentId: '1316',
    bracketGroupId: '1316',
    ocaGroup: '1838090658',
  })
  expect(store.getState().ordersHistory?.[0]?.avgFillPrice).toBeUndefined()
})

it('reads IBKR displaySize back as an Iceberg order', () => {
  const { ib, store } = fixture()
  store.upsertOrder({
    ...baseOrder,
    quantity: 100,
    displaySize: 25,
    customFields: { orderVisibility: 'iceberg', displaySize: 25, retained: true },
  })

  ib.emit(
    EventName.openOrder,
    1316,
    { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    {
      account: 'DU123',
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: 100,
      lmtPrice: 314.1,
      displaySize: 25,
    },
    { status: 'Submitted' },
  )

  expect(store.getState().orders[0]).toMatchObject({
    quantity: 100,
    displaySize: 25,
    customFields: { orderVisibility: 'iceberg', displaySize: 25, retained: true },
  })
})

it.each([
  ['PendingSubmit', 'placing'],
  ['ApiPending', 'placing'],
  ['PreSubmitted', 'pre-submitted'],
  ['Submitted', 'working'],
])('distinguishes IBKR %s from other acknowledgement states', (status, expected) => {
  const { ib, store } = fixture()
  store.upsertOrder({ ...baseOrder, type: 'stop', stopPrice: 300 })
  ib.emit(EventName.orderStatus, 1316, status, 0, 1, 0)
  expect(store.getState().orders[0]?.status).toBe(expected)
  ib.emit(
    EventName.openOrder,
    1316,
    { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    { account: 'DU123', action: 'BUY', orderType: 'STP', totalQuantity: 1, auxPrice: 300 },
    { status },
  )
  expect(store.getState().orders[0]?.status).toBe(expected)
})

it('restores a real completed order by permId without inventing an API order id', () => {
  const { ib, store } = fixture()
  ib.emit(
    EventName.completedOrder,
    { symbol: 'AAPL', secType: 'STK', conId: 100, exchange: 'SMART', currency: 'USD' },
    {
      permId: 700,
      account: 'DU123',
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: 2,
      lmtPrice: 100,
    },
    { completedStatus: 'Filled' },
  )
  expect(store.getState().ordersHistory?.[0]).toMatchObject({
    id: 'perm:700',
    permId: 700,
    status: 'filled',
    filledQuantity: 2,
  })
  expect(store.getState().ordersHistory?.[0]?.brokerOrderId).toBeUndefined()
})

it('matches a completed permId to the stored working order and preserves its API identity', () => {
  const { ib, store } = fixture()
  store.upsertOrder({ ...baseOrder, permId: 700 })
  ib.emit(
    EventName.completedOrder,
    { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    {
      permId: 700,
      account: 'DU123',
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: 1,
      lmtPrice: 100,
    },
    { completedStatus: 'Cancelled' },
  )
  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory?.[0]).toMatchObject({
    id: '1316',
    brokerOrderId: 1316,
    permId: 700,
    status: 'cancelled',
  })
})

it('keeps unbound manual orders and other clients separate despite API id collisions', () => {
  const { ib, store } = fixture()
  const contract = { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' }
  const order = {
    account: 'DU123',
    action: 'BUY',
    orderType: 'LMT',
    totalQuantity: 1,
    lmtPrice: 100,
  }
  ib.emit(
    EventName.openOrder,
    0,
    contract,
    { ...order, permId: 701, clientId: 0 },
    { status: 'Submitted' },
  )
  ib.emit(
    EventName.openOrder,
    0,
    contract,
    { ...order, permId: 702, clientId: 0 },
    { status: 'Submitted' },
  )
  ib.emit(
    EventName.openOrder,
    25,
    contract,
    { ...order, permId: 703, clientId: 0 },
    { status: 'Submitted' },
  )
  ib.emit(
    EventName.openOrder,
    25,
    contract,
    { ...order, permId: 704, clientId: 2 },
    { status: 'Submitted' },
  )
  expect(store.getState().orders.map((o) => o.id)).toEqual([
    'perm:701',
    'perm:702',
    '25',
    'perm:704',
  ])
  ib.emit(EventName.orderStatus, 25, 'Filled', 1, 0, 100, 704, 0, 100, 2)
  expect(store.getState().ordersHistory?.[0]?.id).toBe('perm:704')
  expect(store.getState().orders.find((o) => o.id === '25')?.status).toBe('working')
})

it('does not count individual executions as parent fills for a restored BAG without stored legs', () => {
  const { ib, store } = fixture()
  ib.emit(
    EventName.openOrder,
    1316,
    { symbol: 'AAPL', secType: 'BAG', exchange: 'SMART', currency: 'USD' },
    { account: 'DU123', action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 1 },
    { status: 'Submitted' },
  )
  ib.emit(
    EventName.execDetails,
    0,
    { symbol: 'AAPL', secType: 'OPT', conId: 700, currency: 'USD' },
    {
      orderId: 1316,
      execId: 'leg.01',
      acctNumber: 'DU123',
      side: 'BOT',
      shares: 1,
      price: 2,
      cumQty: 1,
    },
  )
  expect(store.getState().orders[0]).toMatchObject({ id: '1316', status: 'working' })
  expect(store.getState().ordersHistory).toEqual([])
})

it('preserves partial-fill status across Submitted order-status and open-order readbacks', () => {
  const { ib, store } = fixture()
  store.upsertOrder({ ...baseOrder, quantity: 2 })
  ib.emit(EventName.orderStatus, 1316, 'Submitted', 1, 1, 100)
  expect(store.getState().orders[0]?.status).toBe('partially-filled')
  ib.emit(
    EventName.openOrder,
    1316,
    { symbol: 'AAPL', secType: 'STK', currency: 'USD' },
    { account: 'DU123', action: 'BUY', orderType: 'LMT', totalQuantity: 2, lmtPrice: 100 },
    { status: 'Submitted' },
  )
  expect(store.getState().orders[0]).toMatchObject({
    status: 'partially-filled',
    filledQuantity: 1,
    remainingQuantity: 1,
  })
})

it.each(['partially-filled', 'filled'] as const)(
  'does not erase %s quantities on a stale Submitted callback',
  (status) => {
    const { ib, store } = fixture()
    store.upsertOrder({
      ...baseOrder,
      quantity: 2,
      status,
      filledQuantity: status === 'filled' ? 2 : 1,
      remainingQuantity: status === 'filled' ? 0 : 1,
    })
    ib.emit(EventName.orderStatus, 1316, 'Submitted', 0, 2, 0)
    const readback = [...store.getState().orders, ...store.getState().ordersHistory!][0]
    expect(readback).toMatchObject({
      status,
      filledQuantity: status === 'filled' ? 2 : 1,
      remainingQuantity: status === 'filled' ? 0 : 1,
    })
  },
)
