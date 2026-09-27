import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

const symbol = {
  symbol: 'AAPL',
  exchange: 'SMART',
  primaryExchange: 'NASDAQ',
  currency: 'USD',
  assetClass: 'stock',
}

function fixture() {
  vi.useFakeTimers()
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const ib = Object.assign(new EventEmitter(), {
    reqMktData: vi.fn(),
    cancelMktData: vi.fn(),
    reqMarketDataType: vi.fn(),
    reqPositions: vi.fn(),
    reqAccountSummary: vi.fn(),
    reqIds: vi.fn(),
    reqOpenOrders: vi.fn(),
    reqExecutions: vi.fn(),
  })
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({})),
    store,
    ib as unknown as IBApi,
  )
  const currentId = () => ib.reqMktData.mock.calls.at(-1)?.[0] as number
  return { store, ib, service, currentId }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('stock quote recovery', () => {
  it('rejects incomplete bond quotes before registering retry timers or reconnect state', () => {
    const { service, ib } = fixture()
    const pendingTimers = vi.getTimerCount()
    expect(() =>
      service.getQuotes([{ symbol: 'IBKR:123', exchange: 'SMART', assetClass: 'bond' }]),
    ).toThrow('exchange and currency')
    expect(vi.getTimerCount()).toBe(pendingTimers)
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
    expect(ib.reqMktData).not.toHaveBeenCalled()
    service.getQuotes([symbol])
    expect(ib.reqMktData).toHaveBeenCalledTimes(1)
  })

  it('refreshes an aged executable quote from TWS without accepting old callbacks or retry storms', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    const oldId = currentId()
    ib.emit(EventName.tickPrice, oldId, 1, 250)
    ib.emit(EventName.tickPrice, oldId, 2, 251)
    vi.advanceTimersByTime(31_000)
    expect(service.getQuotes([symbol])[0].ask).toBe(251)
    const pending = service.getQuotes([symbol], { maxAgeMs: 30_000 })[0]
    expect(pending.status).toBe('unavailable')
    expect(pending.ask).toBeUndefined()
    expect(ib.cancelMktData).toHaveBeenCalledWith(oldId)
    service.getQuotes([symbol], { maxAgeMs: 30_000 })
    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
    ib.emit(EventName.tickPrice, oldId, 2, 999)
    expect(service.getQuotes([symbol])[0].ask).toBeUndefined()
    ib.emit(EventName.tickPrice, currentId(), 2, 252)
    expect(service.getQuotes([symbol], { maxAgeMs: 30_000 })[0]).toMatchObject({
      status: 'ok',
      ask: 252,
    })
  })
  it('renews an unresolved subscription when the listing exchange becomes available', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([{ ...symbol, primaryExchange: undefined }])
    const oldId = currentId()
    service.getQuotes([symbol])
    expect(ib.cancelMktData).toHaveBeenCalledWith(oldId)
    expect(ib.reqMktData.mock.calls.at(-1)?.[1]).toMatchObject({
      exchange: 'SMART',
      primaryExch: 'NASDAQ',
    })
    service.getQuotes([symbol])
    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
  })

  it('does not refresh price age on a volume or market-data-type callback', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    ib.emit(EventName.tickPrice, currentId(), 1, 250)
    const timestamp = service.getQuotes([symbol])[0].timestamp
    vi.advanceTimersByTime(5_000)
    ib.emit(EventName.tickSize, currentId(), 8, 100)
    ib.emit(EventName.marketDataType, currentId(), 1)
    expect(service.getQuotes([symbol])[0].timestamp).toBe(timestamp)
  })

  it.each([
    [1, 'live'],
    [2, 'frozen'],
    [3, 'delayed'],
    [4, 'delayed-frozen'],
  ] as const)('preserves IBKR market data type %s as %s', (code, type) => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    ib.emit(EventName.tickPrice, currentId(), 1, 250)
    const timestamp = service.getQuotes([symbol])[0].timestamp
    vi.advanceTimersByTime(1000)
    ib.emit(EventName.marketDataType, currentId(), code)
    expect(service.getQuotes([symbol])[0]).toMatchObject({ marketDataType: type, timestamp })
  })

  it('keeps mark and midpoint separate from last and recomputes change from real trades', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    ib.emit(EventName.tickPrice, currentId(), 37, 101)
    ib.emit(EventName.tickPrice, currentId(), 1, 100)
    ib.emit(EventName.tickPrice, currentId(), 2, 102)
    expect(service.getQuotes([symbol])[0]).toMatchObject({ bid: 100, ask: 102, mark: 101 })
    expect(service.getQuotes([symbol])[0].last).toBeUndefined()
    ib.emit(EventName.tickPrice, currentId(), 9, 99)
    ib.emit(EventName.tickPrice, currentId(), 4, 100)
    expect(service.getQuotes([symbol])[0]).toMatchObject({ last: 100, change: 1 })
    ib.emit(EventName.tickPrice, currentId(), 4, 102)
    expect(service.getQuotes([symbol])[0]).toMatchObject({ last: 102, change: 3 })
  })

  it('preserves live and delayed top-of-book sizes without refreshing price age', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    ib.emit(EventName.tickPrice, currentId(), 1, 250)
    ib.emit(EventName.tickPrice, currentId(), 2, 250.01)
    const timestamp = service.getQuotes([symbol])[0].timestamp
    vi.advanceTimersByTime(5_000)
    ib.emit(EventName.tickSize, currentId(), 0, 320)
    ib.emit(EventName.tickSize, currentId(), 70, 1_640)
    expect(service.getQuotes([symbol])[0]).toMatchObject({
      bid: 250,
      bidSize: 320,
      bidUpdatedAt: new Date(Date.parse(timestamp) + 5_000).toISOString(),
      ask: 250.01,
      askSize: 1_640,
      askUpdatedAt: new Date(Date.parse(timestamp) + 5_000).toISOString(),
      timestamp,
    })
    ib.emit(EventName.tickSize, currentId(), 69, -1)
    expect(service.getQuotes([symbol])[0].bidSize).toBeUndefined()
  })

  it('uses paired size ticks to clear unavailable sides while preserving valid zero prices', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    ib.emit(EventName.tickPrice, currentId(), 1, 250)
    ib.emit(EventName.tickSize, currentId(), 0, 100)
    ib.emit(EventName.tickPrice, currentId(), 2, 251)
    ib.emit(EventName.tickSize, currentId(), 3, 120)

    ib.emit(EventName.tickPrice, currentId(), 1, 0)
    expect(service.getQuotes([symbol])[0].bid).toBe(250)
    ib.emit(EventName.tickSize, currentId(), 0, 0)
    expect(service.getQuotes([symbol])[0]).toMatchObject({ ask: 251, askSize: 120 })
    expect(service.getQuotes([symbol])[0].bid).toBeUndefined()
    expect(service.getQuotes([symbol])[0].bidSize).toBeUndefined()
    expect(service.getQuotes([symbol])[0].bidUpdatedAt).toBeUndefined()

    ib.emit(EventName.tickPrice, currentId(), 1, 0)
    ib.emit(EventName.tickSize, currentId(), 0, 25)
    expect(service.getQuotes([symbol])[0]).toMatchObject({ bid: 0, bidSize: 25 })

    ib.emit(EventName.tickPrice, currentId(), 2, -1)
    ib.emit(EventName.tickSize, currentId(), 3, 0)
    expect(service.getQuotes([symbol])[0].ask).toBeUndefined()
    expect(service.getQuotes([symbol])[0].askSize).toBeUndefined()
    expect(service.getQuotes([symbol])[0].askUpdatedAt).toBeUndefined()
  })

  it('restores subscriptions after IBKR reports market-data connection loss and restoration', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    const oldId = currentId()
    ib.emit(EventName.tickPrice, oldId, 1, 250)
    ib.emit(EventName.error, new Error('Connectivity restored - data lost'), 1101, -1)
    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
    expect(service.getQuotes([symbol])[0].bid).toBeUndefined()
    ib.emit(EventName.tickPrice, currentId(), 1, 251)
    expect(service.getQuotes([symbol])[0].bid).toBe(251)
  })

  it('retries a silent subscription with bounded backoff even without another HTTP read', () => {
    const { service, ib, currentId } = fixture()
    expect(service.getQuotes([symbol])[0].status).toBe('unavailable')
    const firstId = currentId()
    expect(ib.reqMktData.mock.calls[0]?.[1]).toMatchObject({
      exchange: 'SMART',
      primaryExch: 'NASDAQ',
    })
    for (let i = 0; i < 20; i++) service.getQuotes([symbol])
    expect(ib.reqMktData).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(15_000)
    expect(ib.cancelMktData).toHaveBeenCalledWith(firstId)
    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
    expect(ib.reqMktData.mock.calls[1]?.[1]).toMatchObject({
      exchange: 'NASDAQ',
    })
    expect(ib.reqMktData.mock.calls[1]?.[1].primaryExch).toBeUndefined()
    const secondId = currentId()
    expect(secondId).not.toBe(firstId)
    vi.advanceTimersByTime(29_999)
    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(ib.reqMktData).toHaveBeenCalledTimes(3)
    ib.emit(EventName.tickPrice, firstId, 1, 99)
    expect(service.getQuotes([symbol])[0].bid).toBeUndefined()
    ib.emit(EventName.tickPrice, currentId(), 66, 250)
    expect(service.getQuotes([symbol])[0]).toMatchObject({ bid: 250, status: 'delayed' })
    vi.advanceTimersByTime(180_000)
    expect(ib.reqMktData).toHaveBeenCalledTimes(3)
  })

  it('keeps a listing-exchange fallback as quote-only data under the SMART symbol', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    vi.advanceTimersByTime(15_000)

    ib.emit(EventName.marketDataType, currentId(), 3)
    ib.emit(EventName.tickPrice, currentId(), 66, 319.07)
    ib.emit(EventName.tickPrice, currentId(), 67, 319.13)
    ib.emit(EventName.tickPrice, currentId(), 68, 319.15)

    expect(service.getQuotes([symbol])[0]).toMatchObject({
      symbol: { symbol: 'AAPL', exchange: 'SMART', primaryExchange: 'NASDAQ' },
      status: 'delayed',
      bid: 319.07,
      ask: 319.13,
      last: 319.15,
    })
    vi.advanceTimersByTime(180_000)
    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
  })

  it('does not treat a data-type callback or volume as a usable price', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    ib.emit(EventName.marketDataType, currentId(), 4)
    ib.emit(EventName.tickSize, currentId(), 74, 100)
    expect(service.getQuotes([symbol])[0].status).toBe('unavailable')
    vi.advanceTimersByTime(15_000)
    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
  })

  it('preserves the broker error with its symbol and clears it after recovery', () => {
    const { service, ib, store, currentId } = fixture()
    service.getQuotes([symbol])
    ib.emit(EventName.error, new Error('No security definition has been found'), 200, currentId())
    expect(service.getQuotes([symbol])[0]).toMatchObject({
      status: 'unavailable',
      ibkrErrorCode: 200,
      unavailableReason: 'No security definition has been found',
    })
    expect(store.getState().connectionStatus).toBe('connected')
    expect(store.getState().diagnostics.at(-1)?.text).toContain('AAPL')
    vi.advanceTimersByTime(15_000)
    ib.emit(EventName.tickPrice, currentId(), 1, 250)
    expect(service.getQuotes([symbol])[0]).toMatchObject({ bid: 250, status: 'ok' })
    expect(service.getQuotes([symbol])[0].unavailableReason).toBeUndefined()
    expect(service.getQuotes([symbol])[0].ibkrErrorCode).toBeUndefined()
  })

  it('keeps delayed ticks flowing after an entitlement warning', () => {
    const { service, ib, currentId } = fixture()
    service.getQuotes([symbol])
    ib.emit(EventName.error, new Error('Displaying delayed market data'), 10167, currentId())
    ib.emit(EventName.tickPrice, currentId(), 66, 250)
    vi.advanceTimersByTime(60_000)
    expect(service.getQuotes([symbol])[0]).toMatchObject({ bid: 250, status: 'delayed' })
    expect(ib.reqMktData).toHaveBeenCalledTimes(1)
  })

  it('invalidates disconnected prices and restores streams without needing a page refresh', () => {
    const { service, ib, store, currentId } = fixture()
    service.getQuotes([symbol])
    const oldId = currentId()
    ib.emit(EventName.tickPrice, oldId, 1, 250)
    const priceTime = store.getState().quotes[0].timestamp
    vi.advanceTimersByTime(1_000)
    ib.emit(EventName.disconnected)
    expect(store.getState().quotes[0]).toMatchObject({
      status: 'unavailable',
      timestamp: priceTime,
    })
    expect(store.getState().quotes[0].bid).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(ib.reqMktData).toHaveBeenCalledTimes(1)
    ib.emit(EventName.connected)
    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
    ib.emit(EventName.tickPrice, oldId, 1, 999)
    expect(service.getQuotes([symbol])[0].bid).toBeUndefined()
    ib.emit(EventName.tickPrice, currentId(), 1, 251)
    expect(service.getQuotes([symbol])[0].bid).toBe(251)
  })
})

it('publishes upstream and farm outages without confusing them with the TWS socket', () => {
  const { ib, store } = fixture()
  ib.emit(EventName.error, new Error('Connectivity between IB and TWS has been lost'), 1100, -1)
  expect(store.getState().connectionStatus).toBe('connected')
  expect(store.getState().marketDataConnection?.status).toBe('disconnected')
  ib.emit(EventName.error, new Error('Market data farm connection is broken:usfarm'), 2103, -1)
  ib.emit(EventName.error, new Error('Connectivity restored - data maintained'), 1102, -1)
  expect(store.getState().marketDataConnection?.status).toBe('degraded')
  ib.emit(EventName.error, new Error('Market data farm connection is OK:eufarm'), 2104, -1)
  expect(store.getState().marketDataConnection?.status).toBe('degraded')
  ib.emit(EventName.error, new Error('Market data farm connection is OK:usfarm'), 2104, -1)
  expect(store.getState().marketDataConnection?.status).toBe('connected')
  ib.emit(EventName.error, new Error('Market data farm connection is inactive:usfarm'), 2108, -1)
  expect(store.getState().marketDataConnection?.status).toBe('connected')
  ib.emit(EventName.disconnected)
  expect(store.getState().connectionStatus).toBe('disconnected')
  expect(store.getState().marketDataConnection?.status).toBe('unknown')
})
