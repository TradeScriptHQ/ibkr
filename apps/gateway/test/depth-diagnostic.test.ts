import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import type { OptionQuoteStreams } from '../src/ibkr/option-quote-streams.js'
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
    reqMktDepth: vi.fn(),
    reqTickByTickData: vi.fn(),
    cancelMktDepth: vi.fn(),
    cancelTickByTickData: vi.fn(),
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

/** The gateway keeps one book per symbol stream; read the one under test. */
function bookFor(store: BrokerStateStore, ticker = 'AAPL') {
  return store.getState().marketDepths?.find((depth) => depth.symbol.symbol === ticker)
}

describe('market depth diagnostics', () => {
  it('reports pending then bounded no-response without refreshing timestamps on reads', () => {
    const { service, ib, store } = fixture()
    const initial = service.getMarketDepth(symbol)
    expect(initial?.diagnostic?.message).toMatch(/^Gateway depth pending:/u)
    for (let elapsed = 0; elapsed < 14_000; elapsed += 1_000) {
      vi.advanceTimersByTime(1_000)
      const current = service.getMarketDepth(symbol)
      expect(current?.updatedAt).toBe(initial?.updatedAt)
      expect(current?.diagnostic?.message).toMatch(/^Gateway depth pending:/u)
    }
    vi.advanceTimersByTime(1_000)
    expect(bookFor(store)).toMatchObject({
      updatedAt: initial?.updatedAt,
      bids: [],
      asks: [],
      diagnostic: { message: expect.stringMatching(/^Gateway depth no response:/u) },
    })
    expect(bookFor(store)?.diagnostic?.code).toBeUndefined()
    expect(ib.reqMktDepth).toHaveBeenCalledTimes(1)
  })

  it('a late native update clears only the local no-response diagnostic', () => {
    const { service, ib, store } = fixture()
    const initial = service.getMarketDepth(symbol)
    const id = ib.reqMktDepth.mock.lastCall?.[0]
    vi.advanceTimersByTime(15_000)
    ib.emit(EventName.updateMktDepth, id, 0, 0, 1, 250, 10)
    expect(bookFor(store)?.bids).toEqual([{ price: 250, size: 10 }])
    expect(bookFor(store)?.diagnostic).toBeUndefined()
    expect(bookFor(store)?.updatedAt).not.toBe(initial?.updatedAt)
  })

  it('new subscriptions own their deadline and refuse old timers, quotes and callbacks', () => {
    const { service, ib, store } = fixture()
    service.getQuotes([symbol])
    const quoteId = ib.reqMktData.mock.lastCall?.[0]
    service.getMarketDepth(symbol)
    const oldId = ib.reqMktDepth.mock.lastCall?.[0]
    vi.advanceTimersByTime(10_000)
    service.getMarketDepth({ ...symbol, symbol: 'MSFT' })
    const currentId = ib.reqMktDepth.mock.lastCall?.[0]
    ib.emit(EventName.error, new Error('Competing live session'), 10197, quoteId)
    ib.emit(EventName.error, new Error('Old depth permission'), 2152, oldId)
    ib.emit(EventName.updateMktDepth, oldId, 0, 0, 1, 999, 1)
    vi.advanceTimersByTime(5_000)
    expect(bookFor(store, 'MSFT')).toMatchObject({
      symbol: { symbol: 'MSFT' },
      bids: [],
      diagnostic: { message: expect.stringMatching(/^Gateway depth pending:/u) },
    })
    vi.advanceTimersByTime(10_000)
    expect(bookFor(store, 'MSFT')?.diagnostic?.message).toMatch(/^Gateway depth no response:/u)
    ib.emit(EventName.updateMktDepth, currentId, 0, 0, 0, 300, 10)
    expect(bookFor(store, 'MSFT')?.diagnostic).toBeUndefined()
  })

  it('a depth-owned native error remains the authority after the pending deadline', () => {
    const { service, ib, store } = fixture()
    service.getMarketDepth(symbol)
    const id = ib.reqMktDepth.mock.lastCall?.[0]
    ib.emit(EventName.error, new Error('Exact depth permission unavailable'), 2152, id)
    vi.advanceTimersByTime(30_000)
    expect(bookFor(store)?.diagnostic).toEqual({
      code: 2152,
      message: 'Exact depth permission unavailable',
    })
  })

  it('disconnect clears a pending timer and reconciliation starts a fresh bounded request', () => {
    const { service, ib, store } = fixture()
    // A terminal window holds its claim for as long as its event stream stays open.
    service.connectStreamClient('window-1')
    service.getMarketDepth(symbol, 20, { clientId: 'window-1', claimId: 'order-book' })
    const oldId = ib.reqMktDepth.mock.lastCall?.[0]
    vi.advanceTimersByTime(5_000)
    ib.emit(EventName.disconnected)
    const disconnected = bookFor(store)
    vi.advanceTimersByTime(20_000)
    expect(bookFor(store)).toEqual(disconnected)
    ib.emit(EventName.connected)
    const currentId = ib.reqMktDepth.mock.lastCall?.[0]
    expect(currentId).not.toBe(oldId)
    const restored = bookFor(store)
    expect(restored?.diagnostic?.message).toMatch(/^Gateway depth pending:/u)
    ib.emit(EventName.updateMktDepth, oldId, 0, 0, 1, 999, 1)
    expect(bookFor(store)?.bids).toEqual([])
    vi.advanceTimersByTime(14_000)
    expect(bookFor(store)?.diagnostic?.message).toMatch(/^Gateway depth pending:/u)
    vi.advanceTimersByTime(1_000)
    expect(bookFor(store)?.diagnostic?.message).toMatch(/^Gateway depth no response:/u)
    expect(bookFor(store)?.updatedAt).toBe(restored?.updatedAt)
  })

  it('a native update before the deadline clears pending and a recovered reset reason', () => {
    const { service, ib, store } = fixture()
    service.getMarketDepth(symbol)
    const id = ib.reqMktDepth.mock.lastCall?.[0]
    ib.emit(EventName.updateMktDepth, id, 0, 0, 1, 250, 10)
    vi.advanceTimersByTime(15_000)
    expect(bookFor(store)?.diagnostic).toBeUndefined()
    ib.emit(EventName.error, new Error('Market depth RESET'), 317, id)
    expect(bookFor(store)?.diagnostic?.code).toBe(317)
    ib.emit(EventName.updateMktDepth, id, 0, 0, 0, 251, 20)
    expect(bookFor(store)?.diagnostic).toBeUndefined()
  })

  it('retains and returns a requested tape history larger than 1000 prints', () => {
    const { service, ib } = fixture()
    service.getTimeAndSales(symbol, 1500)
    const id = ib.reqTickByTickData.mock.calls[0]?.[0]
    for (let index = 0; index < 1500; index++) {
      ib.emit(EventName.tickByTickAllLast, id, 1, '1700000000', 100, 1, {}, 'NASDAQ', '')
    }
    expect(service.getTimeAndSales(symbol, 1500)).toHaveLength(1500)
  })

  it('passes a requested depth larger than 50 to the broker', () => {
    const { service, ib } = fixture()
    service.getMarketDepth(symbol, 100)
    expect(ib.reqMktDepth.mock.calls[0]?.[2]).toBe(100)
  })

  it('restores every active market-data stream after 1101 and rejects old callbacks', () => {
    const { service, ib, store } = fixture()
    const optionStreams = (
      Reflect.get(service, 'options') as { optionQuoteStreams: OptionQuoteStreams }
    ).optionQuoteStreams
    service.getQuotes([symbol])
    optionStreams.read({ conId: 265598, exchange: 'SMART', currency: 'USD' })
    service.getMarketDepth(symbol)
    service.getTimeAndSales(symbol)
    const oldStockId = ib.reqMktData.mock.calls[0]?.[0]
    const oldOptionId = ib.reqMktData.mock.calls[1]?.[0]
    const oldDepthId = ib.reqMktDepth.mock.calls[0]?.[0]
    const oldTapeId = ib.reqTickByTickData.mock.calls[0]?.[0]
    ib.emit(EventName.tickPrice, oldStockId, 1, 250)
    ib.emit(EventName.tickPrice, oldOptionId, 1, 1.25)
    ib.emit(EventName.updateMktDepth, oldDepthId, 0, 0, 1, 250, 10)
    ib.emit(EventName.tickByTickAllLast, oldTapeId, 1, '1700000000', 250, 1, {}, 'NASDAQ', '')

    ib.emit(EventName.error, new Error('Connectivity restored - data lost'), 1101, -1)

    expect(ib.reqMktData).toHaveBeenCalledTimes(4)
    expect(ib.reqMktDepth).toHaveBeenCalledTimes(2)
    expect(ib.reqTickByTickData).toHaveBeenCalledTimes(2)
    const newStockId = ib.reqMktData.mock.calls[2]?.[0]
    const newOptionId = ib.reqMktData.mock.calls[3]?.[0]
    const newDepthId = ib.reqMktDepth.mock.calls[1]?.[0]
    const newTapeId = ib.reqTickByTickData.mock.calls[1]?.[0]
    expect(service.getQuotes([symbol])[0].bid).toBeUndefined()
    expect(optionStreams.read({ conId: 265598, exchange: 'SMART', currency: 'USD' })).toEqual({})
    expect(bookFor(store)).toMatchObject({
      bids: [],
      asks: [],
      diagnostic: { code: 1101 },
    })
    expect(service.getTimeAndSales(symbol)).toEqual([])

    ib.emit(EventName.tickPrice, oldStockId, 1, 999)
    ib.emit(EventName.tickPrice, oldOptionId, 1, 99)
    ib.emit(EventName.updateMktDepth, oldDepthId, 0, 0, 1, 999, 1)
    ib.emit(EventName.tickByTickAllLast, oldTapeId, 1, '1700000001', 999, 1, {}, 'NASDAQ', '')
    expect(service.getQuotes([symbol])[0].bid).toBeUndefined()
    expect(optionStreams.read({ conId: 265598, exchange: 'SMART', currency: 'USD' })).toEqual({})
    expect(bookFor(store)?.bids).toEqual([])
    expect(service.getTimeAndSales(symbol)).toEqual([])

    ib.emit(EventName.tickPrice, newStockId, 1, 251)
    ib.emit(EventName.tickPrice, newOptionId, 1, 1.3)
    ib.emit(EventName.updateMktDepth, newDepthId, 0, 0, 1, 251, 20)
    ib.emit(EventName.tickByTickAllLast, newTapeId, 1, '1700000002', 251, 2, {}, 'NASDAQ', '')
    expect(service.getQuotes([symbol])[0].bid).toBe(251)
    expect(optionStreams.read({ conId: 265598, exchange: 'SMART', currency: 'USD' })).toMatchObject(
      {
        bid: 1.3,
      },
    )
    expect(bookFor(store)?.bids).toEqual([{ price: 251, size: 20 }])
    expect(service.getTimeAndSales(symbol)).toHaveLength(1)
  })

  it('preserves all active market-data streams after 1102', () => {
    const { service, ib, store } = fixture()
    const optionStreams = (
      Reflect.get(service, 'options') as { optionQuoteStreams: OptionQuoteStreams }
    ).optionQuoteStreams
    service.getQuotes([symbol])
    optionStreams.read({ conId: 265598, exchange: 'SMART', currency: 'USD' })
    service.getMarketDepth(symbol)
    service.getTimeAndSales(symbol)
    const quoteId = ib.reqMktData.mock.calls[0]?.[0]
    const optionId = ib.reqMktData.mock.calls[1]?.[0]
    const depthId = ib.reqMktDepth.mock.calls[0]?.[0]
    const tapeId = ib.reqTickByTickData.mock.calls[0]?.[0]
    ib.emit(EventName.tickPrice, quoteId, 1, 250)
    ib.emit(EventName.tickPrice, optionId, 1, 1.25)
    ib.emit(EventName.updateMktDepth, depthId, 0, 0, 1, 250, 10)
    ib.emit(EventName.tickByTickAllLast, tapeId, 1, '1700000000', 250, 1, {}, 'NASDAQ', '')

    ib.emit(EventName.error, new Error('Connectivity restored - data maintained'), 1102, -1)

    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
    expect(ib.reqMktDepth).toHaveBeenCalledTimes(1)
    expect(ib.reqTickByTickData).toHaveBeenCalledTimes(1)
    expect(service.getQuotes([symbol])[0].bid).toBe(250)
    expect(optionStreams.read({ conId: 265598, exchange: 'SMART', currency: 'USD' })).toMatchObject(
      {
        bid: 1.25,
      },
    )
    expect(bookFor(store)?.bids).toEqual([{ price: 250, size: 10 }])
    expect(service.getTimeAndSales(symbol)).toHaveLength(1)
  })

  it('re-subscribes and empties depth after halt code 316', () => {
    const { service, ib, store } = fixture()
    service.getMarketDepth(symbol)
    const oldId = ib.reqMktDepth.mock.calls[0]?.[0]
    ib.emit(EventName.updateMktDepth, oldId, 0, 0, 1, 250, 10)

    ib.emit(EventName.error, new Error('Market depth data has been HALTED'), 316, oldId)

    const newId = ib.reqMktDepth.mock.calls[1]?.[0]
    expect(newId).not.toBe(oldId)
    expect(bookFor(store)).toMatchObject({
      bids: [],
      asks: [],
      diagnostic: { code: 316 },
    })
    ib.emit(EventName.updateMktDepth, oldId, 0, 0, 1, 999, 1)
    expect(bookFor(store)?.bids).toEqual([])
    ib.emit(EventName.updateMktDepth, newId, 0, 0, 1, 251, 20)
    expect(bookFor(store)?.bids).toEqual([{ price: 251, size: 20 }])
  })

  it('empties depth after reset code 317 before applying later entries', () => {
    const { service, ib, store } = fixture()
    service.getMarketDepth(symbol)
    const id = ib.reqMktDepth.mock.calls[0]?.[0]
    ib.emit(EventName.updateMktDepth, id, 0, 0, 1, 250, 10)

    ib.emit(EventName.error, new Error('Market depth data has been RESET'), 317, id)

    expect(ib.reqMktDepth).toHaveBeenCalledTimes(1)
    expect(bookFor(store)).toMatchObject({
      bids: [],
      asks: [],
      diagnostic: { code: 317 },
    })
    ib.emit(EventName.updateMktDepth, id, 0, 0, 1, 251, 20)
    expect(bookFor(store)?.bids).toEqual([{ price: 251, size: 20 }])
  })
  it('retains the broker reason without disconnecting or refreshing prices, and permits partial data', () => {
    const { service, ib, store } = fixture()
    const initial = service.getMarketDepth(symbol)
    const id = ib.reqMktDepth.mock.lastCall?.[0]
    vi.advanceTimersByTime(1000)
    const message =
      'Exchanges - Top: IBEOS; OVERNIGHT; Need additional market data permissions - Depth: NASDAQ; ARCA;'
    ib.emit(EventName.error, new Error(message), 2152, id)
    expect(store.getState().connectionStatus).toBe('connected')
    expect(bookFor(store)).toMatchObject({
      bids: [],
      asks: [],
      updatedAt: initial.updatedAt,
      diagnostic: { code: 2152, message },
    })
    ib.emit(EventName.updateMktDepthL2, id, 0, 'IBEOS', 0, 1, 317, 10, true)
    expect(bookFor(store)).toMatchObject({
      bids: [{ price: 317, size: 10, marketMaker: 'IBEOS' }],
      diagnostic: { code: 2152, message },
    })
    service.getMarketDepth({ ...symbol, symbol: 'MSFT' })
    expect(bookFor(store, 'MSFT')?.diagnostic?.message).toMatch(/^Gateway depth pending:/u)
    ib.emit(EventName.error, new Error(message), 2152, id)
    expect(bookFor(store, 'MSFT')?.diagnostic?.message).toMatch(/^Gateway depth pending:/u)
    expect(bookFor(store)?.diagnostic).toEqual({ code: 2152, message })
  })
})

describe('per-symbol market streams', () => {
  it('keeps one book per window symbol, releases with its window, and waits out IBKR limits', () => {
    const { service, ib, store } = fixture()
    const closeA = service.connectStreamClient('window-a')
    const closeB = service.connectStreamClient('window-b')
    service.getMarketDepth(symbol, 20, { clientId: 'window-a', claimId: 'a-book' })
    const aaplId = ib.reqMktDepth.mock.lastCall?.[0]
    service.getMarketDepth({ ...symbol, symbol: 'MSFT' }, 20, {
      clientId: 'window-b',
      claimId: 'b-book',
    })
    const msftId = ib.reqMktDepth.mock.lastCall?.[0]
    ib.emit(EventName.updateMktDepth, aaplId, 0, 0, 1, 250, 10)
    ib.emit(EventName.updateMktDepth, msftId, 0, 0, 1, 510, 20)
    expect(ib.cancelMktDepth).not.toHaveBeenCalled()
    expect(bookFor(store)?.bids).toEqual([{ price: 250, size: 10 }])
    expect(bookFor(store, 'MSFT')?.bids).toEqual([{ price: 510, size: 20 }])

    // A third book beyond the account limit waits; it never takes a slot from a window.
    service.connectStreamClient('window-c')
    service.getMarketDepth({ ...symbol, symbol: 'TSLA' }, 20, {
      clientId: 'window-c',
      claimId: 'c-book',
    })
    const tslaId = ib.reqMktDepth.mock.lastCall?.[0]
    ib.emit(
      EventName.error,
      new Error('Max number (2) of market depth requests reached'),
      309,
      tslaId,
    )
    expect(bookFor(store, 'TSLA')?.diagnostic).toMatchObject({ code: 309 })
    expect(ib.cancelMktDepth).not.toHaveBeenCalledWith(aaplId, true)

    // Window A releases its book: it lingers briefly, then frees the slot for TSLA.
    service.releaseStreamClaims(['a-book'], 'window-a')
    vi.advanceTimersByTime(4_999)
    expect(ib.cancelMktDepth).not.toHaveBeenCalledWith(aaplId, true)
    vi.advanceTimersByTime(1)
    expect(ib.cancelMktDepth).toHaveBeenCalledWith(aaplId, true)
    expect(bookFor(store)).toBeUndefined()
    expect(ib.reqMktDepth.mock.lastCall?.[1]).toMatchObject({ symbol: 'TSLA' })
    expect(bookFor(store, 'MSFT')?.bids).toEqual([{ price: 510, size: 20 }])

    // Window B closes: its book survives a reconnect allowance, then goes.
    closeB()
    vi.advanceTimersByTime(29_000)
    expect(ib.cancelMktDepth).not.toHaveBeenCalledWith(msftId, true)
    vi.advanceTimersByTime(11_000)
    expect(ib.cancelMktDepth).toHaveBeenCalledWith(msftId, true)
    closeA()
  })
})
