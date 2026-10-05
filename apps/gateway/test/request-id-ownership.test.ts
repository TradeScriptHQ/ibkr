import { EventEmitter } from 'node:events'
import { EventName, type IBApi, SecType } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrRequests } from '../src/ibkr/ibkr-requests.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { OrderDraft } from '../src/ibkr/types.js'
import { OrderIdAllocator } from '../src/tws/order-id-allocator.js'

const symbol = {
  symbol: 'AAPL',
  exchange: 'SMART',
  primaryExchange: 'NASDAQ',
  currency: 'USD',
  assetClass: 'stock',
}
const draft: OrderDraft = {
  accountId: 'DU-ONE',
  symbol,
  side: 'buy',
  type: 'limit',
  duration: 'day',
  quantity: 1,
  limitPrice: 2,
  optionLegs: [
    {
      contract: {
        underlying: 'AAPL',
        underlyingSymbolInfo: symbol,
        expiration: '2027-01-15',
        strike: 100,
        right: 'call',
        multiplier: 100,
      },
      side: 'buy',
      positionEffect: 'open',
      quantity: 1,
    },
  ],
}

function fixture(firstOrderId = 9201) {
  vi.useFakeTimers()
  const ib = Object.assign(new EventEmitter(), {
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    reqIds: vi.fn(),
    reqContractDetails: vi.fn(),
    reqMktData: vi.fn(),
    cancelMktData: vi.fn(),
    reqAccountUpdates: vi.fn(),
    reqPnL: vi.fn(),
    cancelPnL: vi.fn(),
    reqMktDepth: vi.fn(),
    cancelMktDepth: vi.fn(),
    reqTickByTickData: vi.fn(),
    cancelTickByTickData: vi.fn(),
  })
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU-ONE,DU-TWO' })),
    store,
    ib as unknown as IBApi,
  )
  ib.emit(EventName.nextValidId, firstOrderId)
  return { ib, store, service }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function completeQuery(
  service: IbkrService,
  ib: ReturnType<typeof fixture>['ib'],
): Promise<number> {
  const result = service['requests'].requestContractDetails({
    symbol: 'AAPL',
    secType: SecType.STK,
  })
  const id = ib.reqContractDetails.mock.calls.at(-1)?.[0] as number
  ib.emit(EventName.contractDetailsEnd, id)
  await result
  return id
}

function stubOptionResolution(service: IbkrService) {
  vi.spyOn(service['requests'], 'requestMarketRule').mockResolvedValue([
    { lowEdge: 0, increment: 0.01 },
  ])
  vi.spyOn(service['requests'], 'requestContractDetails').mockImplementation(async (contract) => [
    {
      contract: { ...contract, conId: 10 },
      priceMagnifier: 1,
      validExchanges: contract.exchange,
      marketRuleIds: '26',
    },
  ])
}

describe('one ID owner for queries, streams and executable orders', () => {
  it('places a new executable order with a positive API ID even when TWS supplies zero', async () => {
    const { ib, service } = fixture(0)
    stubOptionResolution(service)
    const placed = await service.placeOrder(draft)
    expect(placed.order.brokerOrderId).toBeGreaterThan(0)
    service.cancelOrder(placed.order.id)
    expect(ib.cancelOrder).toHaveBeenCalledWith(placed.order.brokerOrderId)
  })

  it('does not let allocating query IDs substitute for the required nextValidId handshake', () => {
    const ids = new OrderIdAllocator()
    const requests = new IbkrRequests(new EventEmitter() as IBApi, () => true, ids)
    const first = requests.allocateRequestId()
    expect(ids.allocate()).toBeUndefined()
    ids.observeNextValid(first)
    expect(ids.allocate()).not.toBe(first)
  })

  it('keeps query IDs disjoint from orders whether a query or an order comes first', () => {
    for (const queryFirst of [false, true]) {
      const ids = new OrderIdAllocator()
      const requests = new IbkrRequests(new EventEmitter() as IBApi, () => true, ids)
      ids.observeNextValid(9201)
      const first = queryFirst ? requests.allocateRequestId() : ids.allocate()
      const second = queryFirst ? ids.allocate() : requests.allocateRequestId()
      expect(first).not.toBe(second)
      const query = queryFirst ? first : second
      const order = queryFirst ? second : first
      expect(requests.ownsRequestId(Number(query))).toBe(true)
      expect(requests.ownsRequestId(Number(order))).toBe(false)
    }
  })

  it('does not mistake gaps below the latest query ID for query ownership', () => {
    const ids = new OrderIdAllocator()
    const requests = new IbkrRequests(new EventEmitter() as IBApi, () => true, ids)
    ids.observeNextValid(9201)
    const oldOrder = ids.allocate()
    ids.observeUsed(9500)
    const query = requests.allocateRequestId()
    expect(query).toBeGreaterThan(9500)
    expect(requests.ownsRequestId(Number(oldOrder))).toBe(false)
    expect(requests.ownsRequestId(9400)).toBe(false)
    expect(requests.ownsRequestId(query)).toBe(true)
  })

  it('retains query ownership after completion but still routes a real new order rejection', async () => {
    const { ib, store, service } = fixture()
    const queryId = await completeQuery(service, ib)
    stubOptionResolution(service)
    const placed = await service.placeOrder(draft)
    ib.emit(
      EventName.error,
      new Error('Order validation rejected'),
      321,
      Number(placed.order.brokerOrderId),
    )
    expect(
      store.getState().ordersHistory.find((order) => order.id === placed.order.id)?.status,
    ).toBe('rejected')
    expect(placed.order.brokerOrderId).not.toBe(queryId)
    expect(service['requests'].ownsRequestId(queryId)).toBe(true)
  })

  it('retains a timed-out query ID so its late error cannot touch a subsequently placed order', async () => {
    const { ib, store, service } = fixture()
    const pending = service['requests'].requestContractDetails({
      symbol: 'AAPL',
      secType: SecType.STK,
    })
    const id = ib.reqContractDetails.mock.calls[0]?.[0] as number
    const rejected = expect(pending).rejects.toMatchObject({ statusCode: 504 })
    await vi.advanceTimersByTimeAsync(12_000)
    await rejected
    stubOptionResolution(service)
    const placed = await service.placeOrder(draft)
    ib.emit(EventName.error, new Error('Late failed request'), 201, id)
    expect(service['requests'].ownsRequestId(id)).toBe(true)
    expect(store.getState().orders.find((order) => order.id === placed.order.id)?.status).toBe(
      'placing',
    )
    expect(store.getState().connectionStatus).toBe('connected')
  })

  it('cannot consume an earlier genuine order error after later queries raise their high watermark', async () => {
    const { ib, store, service } = fixture()
    stubOptionResolution(service)
    const placed = await service.placeOrder(draft)
    vi.restoreAllMocks()
    const queryId = await completeQuery(service, ib)
    ib.emit(
      EventName.error,
      new Error('Invalid order price'),
      110,
      Number(placed.order.brokerOrderId),
    )
    expect(
      store.getState().ordersHistory.find((order) => order.id === placed.order.id)?.status,
    ).toBe('rejected')
    expect(service['requests'].ownsRequestId(Number(placed.order.brokerOrderId))).toBe(false)
    expect(queryId).not.toBe(placed.order.brokerOrderId)
  })

  it.each([201, 202])('routes even error %s to its retained query owner', async (code) => {
    const { ib, store, service } = fixture()
    const pending = service['requests'].requestContractDetails({
      symbol: 'AAPL',
      secType: SecType.STK,
    })
    const id = ib.reqContractDetails.mock.calls[0]?.[0] as number
    const rejected = expect(pending).rejects.toThrow('Query failed')
    // An old persisted collision must not make the query's error mutate the order.
    store.upsertOrder({
      ...draft,
      id: String(id),
      brokerOrderId: id,
      status: 'placing',
      submittedAt: '2026-09-30T12:00:00Z',
    })
    ib.emit(EventName.error, new Error('Query failed'), code, id)
    await rejected
    expect(store.getState().orders[0]?.status).toBe('placing')
    expect(store.getState().ordersHistory).toEqual([])
  })

  it('allocates PnL away from order 9103 and preserves the order on a PnL rejection', async () => {
    const { ib, store, service } = fixture(9103)
    stubOptionResolution(service)
    const placed = await service.placeOrder(draft)
    ib.emit(EventName.managedAccounts, 'DU-ONE')
    const pnlId = ib.reqPnL.mock.calls[0]?.[0] as number
    ib.emit(EventName.error, new Error('PnL request failed'), 322, pnlId)
    expect(store.getState().orders.find((order) => order.id === placed.order.id)?.status).toBe(
      'placing',
    )
    expect(pnlId).not.toBe(placed.order.brokerOrderId)
    expect(service['requests'].ownsRequestId(pnlId)).toBe(true)
    expect(store.getState().connectionStatus).toBe('connected')
  })

  it('changes PnL request identity with the account so late callbacks cannot overwrite the new account', () => {
    const { ib, store, service } = fixture()
    ib.emit(EventName.managedAccounts, 'DU-ONE,DU-TWO')
    const oldId = ib.reqPnL.mock.calls[0]?.[0] as number
    service.setActiveAccount('DU-TWO')
    const newId = ib.reqPnL.mock.calls.at(-1)?.[0] as number
    expect(newId).not.toBe(oldId)
    expect(ib.cancelPnL).toHaveBeenCalledWith(oldId)
    ib.emit(EventName.pnl, oldId, 900, 800, 100)
    expect(
      store.getState().accounts.find((account) => account.id === 'DU-TWO')?.dailyPnl,
    ).toBeUndefined()
    ib.emit(EventName.pnl, newId, 25, 20, 5)
    expect(store.getState().accounts.find((account) => account.id === 'DU-TWO')?.dailyPnl).toBe(25)
    expect(service['requests'].ownsRequestId(oldId)).toBe(true)
  })

  it.each([300, 366, 201])(
    'keeps cancelled stock quote ID ownership for late error %s',
    async (code) => {
      const { ib, store, service } = fixture()
      service.getQuotes([{ ...symbol, primaryExchange: undefined }])
      const oldId = ib.reqMktData.mock.calls[0]?.[0] as number
      // A listing refinement cancels the old quote even before it has a valid price.
      service.getQuotes([symbol])
      expect(ib.cancelMktData).toHaveBeenCalledWith(oldId)
      stubOptionResolution(service)
      const placed = await service.placeOrder(draft)
      ib.emit(EventName.error, new Error('Cancelled market-data request'), code, oldId)
      expect(store.getState().orders.find((order) => order.id === placed.order.id)?.status).toBe(
        'placing',
      )
      expect(store.getState().connectionStatus).toBe('connected')
      expect(service['requests'].ownsRequestId(oldId)).toBe(true)
      expect(placed.order.brokerOrderId).not.toBe(oldId)
    },
  )

  it('retains option, depth and tape IDs after streams are replaced', () => {
    const { ib, store, service } = fixture()
    service['options'].optionQuoteStreams.read({ conId: 10, secType: SecType.OPT })
    const optionId = ib.reqMktData.mock.calls[0]?.[0] as number
    service['options'].optionQuoteStreams.readMany([{ conId: 11, secType: SecType.OPT }])
    service.getMarketDepth(symbol)
    const depthId = ib.reqMktDepth.mock.calls[0]?.[0] as number
    service.getMarketDepth({ ...symbol, symbol: 'MSFT' })
    service.getTimeAndSales(symbol)
    const tapeId = ib.reqTickByTickData.mock.calls[0]?.[0] as number
    service.getTimeAndSales({ ...symbol, symbol: 'MSFT' })
    expect(ib.cancelMktData).toHaveBeenCalledWith(optionId)
    expect(ib.cancelMktDepth).toHaveBeenCalledWith(depthId, true)
    expect(ib.cancelTickByTickData).toHaveBeenCalledWith(tapeId)
    for (const id of [optionId, depthId, tapeId]) {
      expect(service['requests'].ownsRequestId(id)).toBe(true)
      ib.emit(EventName.error, new Error('Old subscription cancelled'), 300, id)
      expect(store.getState().connectionStatus).toBe('connected')
    }
  })
})
