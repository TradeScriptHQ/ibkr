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
