import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import { AggressorClassifier } from '../src/ibkr/trade-aggressor.js'

const symbol = {
  symbol: 'AAPL',
  exchange: 'SMART',
  primaryExchange: 'NASDAQ',
  currency: 'USD',
  assetClass: 'stock',
}

function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-06T14:00:00Z'))
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
  })
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({})),
    store,
    ib as unknown as IBApi,
  )
  service.getTimeAndSales(symbol)
  const tapeId = ib.reqTickByTickData.mock.calls[0]?.[0] as number
  let second = 1_790_000_000
  const trade = (price: number, size = 1) => {
    second += 1
    ib.emit(EventName.tickByTickAllLast, tapeId, 1, String(second), price, size, {}, 'NASDAQ', '')
  }
  const quote = (bid: number, ask: number, marketDataType: 'live' | 'delayed' = 'live') =>
    store.upsertQuote({
      symbol,
      bid,
      ask,
      timestamp: new Date().toISOString(),
      status: marketDataType === 'live' ? 'ok' : 'delayed',
      marketDataType,
    })
  const sides = () => service.getTimeAndSales(symbol).map((print) => print.aggressor)
  return { store, ib, service, trade, quote, sides }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('AggressorClassifier', () => {
  it('applies the quote rule at, through and inside the spread', () => {
    const classifier = new AggressorClassifier()
    const book = { bid: 100, ask: 100.1 }
    expect(classifier.classify(100.1, book)).toBe('buy')
    expect(classifier.classify(100.2, book)).toBe('buy')
    expect(classifier.classify(100, book)).toBe('sell')
    expect(classifier.classify(99.9, book)).toBe('sell')
    expect(classifier.classify(100.08, book)).toBe('buy')
    expect(classifier.classify(100.02, book)).toBe('sell')
  })

  it('falls back to the tick test at the midpoint and without a usable quote', () => {
    const classifier = new AggressorClassifier()
    expect(classifier.classify(50, undefined)).toBeUndefined()
    expect(classifier.classify(50.5, undefined)).toBe('buy')
    // A zero tick keeps the direction of the last price change.
    expect(classifier.classify(50.5, undefined)).toBe('buy')
    expect(classifier.classify(50.25, { bid: 50, ask: 50.5 })).toBe('sell')
    expect(classifier.classify(50.25, { bid: 50.5, ask: 50 })).toBe('sell')
    expect(classifier.classify(50.3, { bid: 0, ask: 50.5 })).toBe('buy')
  })
})

describe('time and sales aggressor', () => {
  it('classifies prints against the live quote the gateway already holds', () => {
    const { trade, quote, sides } = fixture()
    quote(100, 100.1)
    trade(100.1)
    trade(100)
    trade(100.07)
    expect(sides()).toEqual(['buy', 'sell', 'buy'])
  })

  it('ignores delayed quotes and classifies by tick direction instead', () => {
    const { trade, quote, sides } = fixture()
    quote(90, 90.1, 'delayed')
    trade(100)
    trade(100.05)
    trade(100.01)
    expect(sides()).toEqual([undefined, 'buy', 'sell'])
  })

  it('prefers the fresher top of the depth book over an older quote', () => {
    const { service, ib, trade, quote, sides } = fixture()
    quote(99, 99.1)
    vi.advanceTimersByTime(3_000)
    service.getMarketDepth(symbol)
    const depthId = ib.reqMktDepth.mock.calls[0]?.[0]
    ib.emit(EventName.updateMktDepth, depthId, 0, 0, 1, 100, 5)
    ib.emit(EventName.updateMktDepth, depthId, 0, 0, 0, 100.1, 5)
    trade(100)
    trade(100.1)
    expect(sides()).toEqual(['sell', 'buy'])
  })

  it('serves a time window and a sequence cursor for backward history paging', () => {
    const { service, trade } = fixture()
    for (let index = 0; index < 10; index++) trade(100 + index / 100)
    const all = service.getTimeAndSales(symbol, 200)
    const window = service.getTimeAndSales(symbol, 200, undefined, {
      startTime: all[2]!.time,
      endTime: all[7]!.time,
    })
    expect(window.map((print) => print.sequence)).toEqual([3, 4, 5, 6, 7, 8])
    const page = service.getTimeAndSales(symbol, 3, undefined, { beforeSequence: 8 })
    expect(page.map((print) => print.sequence)).toEqual([5, 6, 7])
  })

  it('bounds tape retention however large a history page is requested', () => {
    const { service, trade } = fixture()
    service.getTimeAndSales(symbol, 1_000_000)
    for (let index = 0; index < 60_000; index++) trade(100)
    const prints = service.getTimeAndSales(symbol, 1_000_000)
    expect(prints.length).toBe(50_000)
    expect(prints[prints.length - 1]?.sequence).toBe(60_000)
  })
})
