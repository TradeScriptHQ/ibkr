import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { afterEach, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { OrderDraft } from '../src/ibkr/types.js'

const draft: OrderDraft = {
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
  limitPrice: 1,
}

it('rejects a direct routing destination for Overnight + DAY before broker submission', async () => {
  const { service, ib } = fixture()
  const result = await service.previewOrder({
    ...draft,
    duration: 'overnight-day',
    routingDestination: 'ARCA',
  })
  expect(result).toEqual({
    accepted: false,
    reason: 'IBKR Overnight + DAY orders require SMART routing.',
  })
  expect(ib.placeOrder).not.toHaveBeenCalled()
})
function fixture(mode: 'paper' | 'live' = 'paper') {
  vi.useFakeTimers()
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const ib = Object.assign(new EventEmitter(), {
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    reqIds: vi.fn(),
    reqOpenOrders: vi.fn(),
  })
  const service = new IbkrService(
    createBridgeConfig(
      loadGatewayConfig({
        IBKR_ALLOWED_ACCOUNT_IDS: 'DU123',
        IBKR_EXECUTION_ENVIRONMENT: mode,
        IBKR_PORT: mode === 'live' ? '7496' : '7497',
      }),
    ),
    store,
    ib as unknown as IBApi,
  )
  ib.emit(EventName.nextValidId, 100)
  return { service, ib, store }
}
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it.each(['market', 'large-limit'] as const)(
  'passes %s orders to broker preview without an invented live notional gate',
  async (kind) => {
    const { service, ib } = fixture('live')
    const { limitPrice: _limit, ...base } = draft
    const input: OrderDraft =
      kind === 'market'
        ? { ...base, type: 'market' }
        : { ...draft, quantity: 200_000, limitPrice: 2 }
    const result = service.previewOrder(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(ib.placeOrder).toHaveBeenCalledTimes(1)
    expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({ whatIf: true })
    ib.emit(EventName.openOrder, 100, {}, { whatIf: true }, { commission: 1 })
    expect(await result).toMatchObject({ accepted: true, source: 'broker' })
  },
)

it('keeps explicit live mutation authorization after removing the notional gate', () => {
  const { service, ib, store } = fixture('live')
  store.setAccounts([{ id: 'DU123', label: 'Test', currency: 'USD' }])
  expect(() => service.cancelOrder('123')).toThrow('This connection is read-only')
  expect(ib.cancelOrder).not.toHaveBeenCalled()
})

it('waits for broker cancellation and clears the earlier warning only on the final event', () => {
  const { service, ib, store } = fixture()
  store.upsertOrder({
    ...draft,
    id: '123',
    brokerOrderId: 123,
    status: 'placing',
    submittedAt: new Date().toISOString(),
    message: 'Earlier broker warning',
  })
  service.cancelOrder('123')
  expect(ib.cancelOrder).toHaveBeenCalledWith(123)
  expect(store.getState().ordersHistory).toEqual([])
  expect(store.getState().orders[0].message).toContain('Waiting for IBKR acknowledgement')
  ib.emit(EventName.orderStatus, 123, 'Cancelled', 0, 1, 0)
  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory[0]).toMatchObject({
    status: 'cancelled',
    filledQuantity: 0,
  })
  expect(store.getState().ordersHistory[0].message).toBeUndefined()
  expect(store.getState().messages.at(-1)?.text).toBe('Cancel requested for order 123')
  vi.advanceTimersByTime(250)
  expect(store.getState().messages.at(-1)?.text).toBe(
    'Order 123 status changed from placing to cancelled',
  )
})

it('retains a late IBKR price-control rejection after the cancelled status callback', () => {
  const { ib, store } = fixture()
  store.upsertOrder({
    ...draft,
    id: '1334',
    brokerOrderId: 1334,
    status: 'working',
    limitPrice: 0.48,
    optionLegs: [
      {
        contract: {
          underlying: 'AAPL',
          underlyingSymbolInfo: draft.symbol,
          expiration: '2026-09-09',
          strike: 317.5,
          right: 'call',
          multiplier: 100,
          currency: 'USD',
        },
        side: 'buy',
        positionEffect: 'open',
        quantity: 1,
      },
    ],
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  ib.emit(EventName.orderStatus, 1334, 'Cancelled', 0, 1, 0)
  ib.emit(
    EventName.error,
    new Error(
      'Order Canceled - reason:We cannot accept an order at a limit price at or more aggressive than 0.33. Please submit your order using a <br>limit price that is closer to the current market price of 0.08.',
    ),
    202,
    1334,
  )

  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory[0]).toMatchObject({
    id: '1334',
    status: 'rejected',
    message:
      'Order Canceled - reason:We cannot accept an order at a limit price at or more aggressive than 0.33. Please submit your order using a limit price that is closer to the current market price of 0.08. (202 req 1334)',
    customFields: {
      ibkrOrderRejection: {
        kind: 'price-control',
        boundaryPrice: 0.33,
        referencePrice: 0.08,
        submittedLimitPrice: 0.48,
      },
    },
  })
  expect(store.getState().messages.at(-1)).toMatchObject({
    level: 'error',
    text: expect.stringContaining('Order 1334 rejected by IBKR'),
  })
  vi.advanceTimersByTime(250)
  expect(store.getState().messages.at(-1)?.level).toBe('error')
})

it('blocks a mismatched contract from an older browser before contacting IBKR', async () => {
  const { service, ib } = fixture()
  const result = await service.previewOrder({
    ...draft,
    symbol: { ...draft.symbol, currency: 'EUR', sourceSymbol: { ticker: 'AAPL', currency: 'USD' } },
  })
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain('does not match instrument currency USD')
  expect(ib.placeOrder).not.toHaveBeenCalled()
})

it('rejects an invalid Iceberg display size locally and addresses the ticket field', async () => {
  const { service, ib } = fixture()
  const result = await service.previewOrder({
    ...draft,
    quantity: 100,
    displaySize: 100,
    customFields: { orderVisibility: 'iceberg', displaySize: 100 },
  })

  expect(result).toMatchObject({
    accepted: false,
    reason: 'Displayed quantity must be smaller than total quantity.',
    fieldErrors: [
      {
        fieldId: 'displaySize',
        message: 'Displayed quantity must be smaller than total quantity.',
      },
    ],
  })
  expect(ib.placeOrder).not.toHaveBeenCalled()
})

it('passes a valid Iceberg display size to the IBKR what-if order', async () => {
  const { service, ib } = fixture()
  const result = service.previewOrder({
    ...draft,
    quantity: 100,
    displaySize: 25,
    customFields: { orderVisibility: 'iceberg', displaySize: 25 },
  })
  await vi.advanceTimersByTimeAsync(0)

  expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({
    totalQuantity: 100,
    displaySize: 25,
    whatIf: true,
  })
  ib.emit(EventName.openOrder, 100, {}, { whatIf: true }, { commission: 1 })
  expect(await result).toMatchObject({ accepted: true, source: 'broker' })
})

it('maps a crypto market buy to TWS cashQty without totalQuantity', async () => {
  const { service, ib } = fixture()
  const result = service.previewOrder({
    ...draft,
    symbol: {
      symbol: 'BTC',
      exchange: 'PAXOS',
      currency: 'USD',
      assetClass: 'crypto',
    },
    type: 'market',
    duration: 'ioc',
    quantity: 0,
    cashQuantity: 25,
    limitPrice: undefined,
  })
  await vi.advanceTimersByTimeAsync(0)

  const sent = ib.placeOrder.mock.calls[0]?.[2]
  expect(sent).toMatchObject({ action: 'BUY', orderType: 'MKT', tif: 'IOC', cashQty: 25 })
  expect(sent).not.toHaveProperty('totalQuantity')
  ib.emit(EventName.openOrder, 100, {}, { whatIf: true }, { commission: 1 })
  expect(await result).toMatchObject({ accepted: true, source: 'broker' })
})

it('rejects crypto market buys that mix cash and instrument quantity', async () => {
  const { service, ib } = fixture()
  const result = await service.previewOrder({
    ...draft,
    symbol: { symbol: 'BTC', exchange: 'PAXOS', currency: 'USD', assetClass: 'crypto' },
    type: 'market',
    duration: 'ioc',
    quantity: 0.001,
    cashQuantity: 25,
    limitPrice: undefined,
  })

  expect(result).toMatchObject({
    accepted: false,
    reason: 'Crypto market buys use cash amount and cannot also specify instrument quantity.',
  })
  expect(ib.placeOrder).not.toHaveBeenCalled()
})

it('rejects Iceberg for a direct route before contacting IBKR', async () => {
  const { service, ib } = fixture()
  const result = await service.previewOrder({
    ...draft,
    quantity: 100,
    routingDestination: 'ISLAND',
    displaySize: 25,
    customFields: { orderVisibility: 'iceberg', displaySize: 25 },
  })

  expect(result).toMatchObject({
    accepted: false,
    reason: 'Iceberg is supported only for USD stock orders routed through SMART.',
    fieldErrors: [expect.objectContaining({ fieldId: 'displaySize' })],
  })
  expect(ib.placeOrder).not.toHaveBeenCalled()
})

it('clears displaySize from an existing Iceberg order during modification', async () => {
  const { service, ib, store } = fixture()
  store.upsertOrder({
    ...draft,
    id: '555',
    brokerOrderId: 555,
    quantity: 100,
    displaySize: 25,
    customFields: { orderVisibility: 'iceberg', displaySize: 25 },
    status: 'working',
    submittedAt: '2026-09-10T12:00:00.000Z',
    updatedAt: '2026-09-10T12:00:00.000Z',
  })

  const result = service.modifyOrder('555', {
    displaySize: null,
    customFields: { orderVisibility: 'visible', displaySize: 25 },
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({ whatIf: true })
  expect(ib.placeOrder.mock.calls[0]?.[2].displaySize).toBeUndefined()
  ib.emit(EventName.openOrder, 100, {}, { whatIf: true }, { commission: 1 })
  await vi.advanceTimersByTimeAsync(0)

  expect((await result).order).toMatchObject({
    id: '555',
    customFields: { orderVisibility: 'visible' },
  })
  expect((await result).order.displaySize).toBeUndefined()
  expect(ib.placeOrder.mock.calls[1]?.[0]).toBe(555)
  expect(ib.placeOrder.mock.calls[1]?.[2].displaySize).toBeUndefined()
})

it('reports a broker contract rejection immediately rather than waiting for a timeout', async () => {
  const { service, ib } = fixture()
  const result = service.previewOrder(draft)
  await vi.advanceTimersByTimeAsync(0)
  ib.emit(EventName.error, new Error('No security definition has been found'), 200, 100)
  expect(await result).toMatchObject({
    accepted: false,
    source: 'broker',
    reason: 'No security definition has been found (200 req 100)',
  })
})

it('blocks an actual order when broker preview times out', async () => {
  const { service, ib, store } = fixture()
  const placement = service.placeOrder(draft)
  const rejection = expect(placement).rejects.toThrow(
    'IBKR order preview timed out. Order not sent.',
  )
  await vi.advanceTimersByTimeAsync(9_000)
  await rejection
  expect(ib.placeOrder).toHaveBeenCalledTimes(1)
  expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({ whatIf: true })
  expect(store.getState().orders).toEqual([])
})

it('requires a broker callback for successful preview and retains genuine warnings', async () => {
  const { service, ib, store } = fixture()
  store.setAccounts([{ id: 'DU123', label: 'Paper', currency: 'EUR' }])
  const result = service.previewOrder(draft)
  await vi.advanceTimersByTimeAsync(0)
  ib.emit(EventName.error, new Error('Order will be held until the session opens'), 399, 100)
  ib.emit(
    EventName.openOrder,
    100,
    {},
    { whatIf: true },
    { commission: 1, commissionCurrency: 'USD', initMarginChange: '10', status: 'PreSubmitted' },
  )
  expect(await result).toMatchObject({
    accepted: true,
    source: 'broker',
    estimatedCommission: 1,
    commissionCurrency: 'USD',
    estimatedMargin: 10,
    marginCurrency: 'EUR',
    warnings: ['Order will be held until the session opens (399 req 100)'],
  })
})

it('does not infer missing commission or margin currency from the instrument', async () => {
  const { service, ib } = fixture()
  const result = service.previewOrder(draft)
  await vi.advanceTimersByTimeAsync(0)
  ib.emit(EventName.openOrder, 100, {}, { whatIf: true }, { commission: 1, initMarginChange: '10' })
  const preview = await result
  expect(preview).toMatchObject({ accepted: true, estimatedCommission: 1, estimatedMargin: 10 })
  expect(preview.commissionCurrency).toBeUndefined()
  expect(preview.marginCurrency).toBeUndefined()
  expect(preview.estimatedFees).toBeUndefined()
})

it('preserves IBKR commission bounds when no exact what-if commission is available', async () => {
  const { service, ib } = fixture()
  const result = service.previewOrder(draft)
  await vi.advanceTimersByTimeAsync(0)
  ib.emit(
    EventName.openOrder,
    100,
    {},
    { whatIf: true },
    { minCommission: 0.35, maxCommission: 1, commissionCurrency: 'USD' },
  )

  expect(await result).toMatchObject({
    accepted: true,
    estimatedCommissionRange: { minimum: 0.35, maximum: 1 },
    commissionCurrency: 'USD',
  })
})

const bracketDraft: OrderDraft = {
  ...draft,
  limitPrice: 312.94,
  takeProfitOutsideRth: true,
  exits: {
    levels: [
      {
        id: 'first',
        quantity: 1,
        takeProfit: { price: 314.07 },
        stopLoss: { kind: 'fixed', triggerPrice: 312.05 },
      },
    ],
  },
}

it('previews bracket legs as independent what-if orders without staging orders or summing alternative commissions', async () => {
  const { service, ib, store } = fixture()
  const result = service.previewOrder(bracketDraft)
  await vi.advanceTimersByTimeAsync(0)
  expect(ib.placeOrder).toHaveBeenCalledTimes(1)
  ib.emit(
    EventName.openOrder,
    100,
    {},
    { whatIf: true },
    { commission: 1, commissionCurrency: 'USD', initMarginChange: '10' },
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(ib.placeOrder).toHaveBeenCalledTimes(3)
  for (const [, , order] of ib.placeOrder.mock.calls) {
    expect(order).toMatchObject({ whatIf: true, transmit: true, totalQuantity: 1 })
    expect(order.parentId).toBeUndefined()
    expect(order.ocaGroup).toBeUndefined()
  }
  expect(ib.placeOrder.mock.calls[1]?.[2]).toMatchObject({
    action: 'SELL',
    orderType: 'LMT',
    lmtPrice: 314.07,
    outsideRth: true,
  })
  expect(ib.placeOrder.mock.calls[2]?.[2]).toMatchObject({
    action: 'SELL',
    orderType: 'STP',
    auxPrice: 312.05,
  })
  expect(ib.placeOrder.mock.calls[0]?.[2].outsideRth).toBeUndefined()
  expect(ib.placeOrder.mock.calls[2]?.[2].outsideRth).toBeUndefined()
  ib.emit(
    EventName.openOrder,
    102,
    {},
    { whatIf: true },
    { commission: 2, commissionCurrency: 'USD', initMarginChange: '90' },
  )
  ib.emit(
    EventName.openOrder,
    101,
    {},
    { whatIf: true },
    { commission: 1.5, commissionCurrency: 'USD', initMarginChange: '80' },
  )
  expect(await result).toMatchObject({
    accepted: true,
    source: 'broker',
    estimatedCommission: 1,
    estimatedMargin: 10,
    exitCommissions: [
      {
        levelId: 'first',
        leg: 'take-profit',
        quantity: 1,
        estimatedCommission: 1.5,
        commissionCurrency: 'USD',
      },
      {
        levelId: 'first',
        leg: 'stop-loss',
        quantity: 1,
        estimatedCommission: 2,
        commissionCurrency: 'USD',
      },
    ],
  })
  expect(store.getState().orders).toEqual([])
  expect(store.getState().executions).toEqual([])
})

it('places and reads back outside-RTH on the take-profit child only', async () => {
  const { service, ib, store } = fixture()
  vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({ accepted: true })

  await service.placeOrder({ ...bracketDraft, outsideRth: true })

  expect(ib.placeOrder).toHaveBeenCalledTimes(3)
  expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({
    orderId: 100,
    transmit: false,
    outsideRth: true,
  })
  expect(ib.placeOrder.mock.calls[1]?.[2]).toMatchObject({
    orderId: 101,
    orderType: 'LMT',
    parentId: 100,
    outsideRth: true,
  })
  expect(ib.placeOrder.mock.calls[2]?.[2]).toMatchObject({
    orderId: 102,
    orderType: 'STP',
    parentId: 100,
  })
  expect(ib.placeOrder.mock.calls[2]?.[2].outsideRth).toBeUndefined()

  const takeProfit = store.getState().orders.find((order) => order.id === '101')
  const stopLoss = store.getState().orders.find((order) => order.id === '102')
  expect(takeProfit?.outsideRth).toBe(true)
  expect(stopLoss?.outsideRth).toBeUndefined()

  const [, contract, wireOrder] = ib.placeOrder.mock.calls[1] ?? []
  ib.emit(EventName.openOrder, 101, contract, wireOrder, { status: 'Submitted' })
  expect(store.getState().orders.find((order) => order.id === '101')).toMatchObject({
    status: 'working',
    outsideRth: true,
  })
})

it('preserves an entry estimate when a hypothetical exit is rejected or times out', async () => {
  const { service, ib } = fixture()
  const result = service.previewOrder(bracketDraft)
  await vi.advanceTimersByTimeAsync(0)
  ib.emit(
    EventName.openOrder,
    100,
    {},
    { whatIf: true },
    { commission: 1, commissionCurrency: 'USD' },
  )
  await vi.advanceTimersByTimeAsync(0)
  ib.emit(EventName.error, new Error('Short sale unavailable'), 201, 101)
  await vi.advanceTimersByTimeAsync(9_000)
  const preview = await result
  expect(preview.accepted).toBe(true)
  expect(preview.estimatedCommission).toBe(1)
  expect(preview.exitCommissions?.[0]?.reason).toContain('Short sale unavailable')
  expect(preview.exitCommissions?.[1]?.reason).toContain('Timed out')
  expect(preview.warnings?.join(' ')).toContain('commission unavailable')
})

it('rejects a bracket preview if IBKR rejects its entry, without requesting exits', async () => {
  const { service, ib } = fixture()
  const result = service.previewOrder(bracketDraft)
  await vi.advanceTimersByTimeAsync(0)
  ib.emit(EventName.error, new Error('Entry rejected'), 201, 100)
  expect(await result).toMatchObject({ accepted: false, reason: 'Entry rejected (201 req 100)' })
  expect(ib.placeOrder).toHaveBeenCalledTimes(1)
})

it.each([undefined, null, '', Number.MAX_VALUE, -1, 0])(
  'does not invent a commission from IBKR unset values: %s',
  async (commission) => {
    const { service, ib } = fixture()
    const result = service.previewOrder(draft)
    await vi.advanceTimersByTimeAsync(0)
    ib.emit(EventName.openOrder, 100, {}, { whatIf: true }, { commission })
    expect((await result).estimatedCommission).toBe(commission === 0 ? 0 : undefined)
  },
)

it('previews an existing exit independently of its filled parent without changing the actual bracket', async () => {
  const { service, ib, store } = fixture()
  const exit = {
    ...draft,
    id: '1299',
    brokerOrderId: 1299,
    side: 'sell' as const,
    limitPrice: 314.55,
    status: 'working' as const,
    parentId: '1298',
    parentType: 'order' as const,
    bracketGroupId: '1298',
    ocaGroup: 'existing-oca',
    ocaType: 2,
    submittedAt: '2026-09-09T16:27:20.900Z',
  }
  store.upsertOrder(exit)
  const before = structuredClone(store.getState().orders)
  const result = service.previewModifyOrder('1299', { limitPrice: 315 })
  await vi.advanceTimersByTimeAsync(0)
  const sent = ib.placeOrder.mock.calls[0]?.[2]
  expect(sent).toMatchObject({ whatIf: true, action: 'SELL', lmtPrice: 315, totalQuantity: 1 })
  expect(sent.parentId).toBeUndefined()
  expect(sent.ocaGroup).toBeUndefined()
  expect(sent.ocaType).toBeUndefined()
  ib.emit(
    EventName.openOrder,
    100,
    {},
    { whatIf: true },
    { commission: 1, commissionCurrency: 'USD' },
  )
  expect(await result).toMatchObject({ accepted: true, estimatedCommission: 1 })
  expect(store.getState().orders).toEqual(before)
  expect(ib.cancelOrder).not.toHaveBeenCalled()
})

it('keeps the paper futures percentage override on placement and modification', async () => {
  const { service, ib } = fixture()
  vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({ accepted: true })
  const placed = await service.placeOrder({
    ...draft,
    symbol: { symbol: 'IBKR:123', assetClass: 'futures', exchange: 'CME', currency: 'USD' },
  })
  expect(ib.placeOrder.mock.calls.at(-1)?.[2]).toMatchObject({
    overridePercentageConstraints: true,
  })
  await service.modifyOrder(placed.order!.id, { limitPrice: 2 })
  expect(ib.placeOrder.mock.calls.at(-1)?.[2]).toMatchObject({
    overridePercentageConstraints: true,
  })
})

it('preserves an order after the nonfatal 2109 outside-hours warning', () => {
  const { store, ib } = fixture()
  store.upsertOrder({
    ...draft,
    id: '123',
    brokerOrderId: 123,
    status: 'working',
    submittedAt: new Date().toISOString(),
  })
  ib.emit(
    EventName.error,
    new Error('Outside Regular Trading Hours is ignored. PlaceOrder is now being processed.'),
    2109,
    123,
  )
  expect(store.getState().orders[0]).toMatchObject({
    id: '123',
    status: 'working',
    message:
      'Outside Regular Trading Hours is ignored. PlaceOrder is now being processed. (2109 req 123)',
  })
  expect(store.getState().ordersHistory).toEqual([])
  expect(store.getState().messages.at(-1)).toMatchObject({
    level: 'warning',
    text: expect.stringContaining('Order 123 warning from IBKR'),
  })
  ib.emit(EventName.orderStatus, 123, 'Submitted', 0, 1, 0)
  expect(store.getState().orders[0]?.status).toBe('working')
})

it('keeps a pending order visible when IBKR cannot complete its cancellation', () => {
  const { store, ib } = fixture()
  store.upsertOrder({
    ...draft,
    id: '123',
    brokerOrderId: 123,
    status: 'placing',
    submittedAt: new Date().toISOString(),
  })
  ib.emit(EventName.error, new Error('Cannot be cancelled, state: PendingCancel.'), 10148, 123)
  expect(store.getState().orders[0]).toMatchObject({ id: '123', status: 'placing' })
  expect(store.getState().ordersHistory).toEqual([])
  expect(ib.reqOpenOrders).toHaveBeenCalled()
  ib.emit(EventName.orderStatus, 123, 'Cancelled', 0, 1, 0)
  expect(store.getState().orders).toEqual([])
  expect(store.getState().ordersHistory?.[0]?.status).toBe('cancelled')
})
