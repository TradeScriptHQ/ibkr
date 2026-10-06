import { EventEmitter } from 'node:events'
import { type Contract, EventName, type IBApi, SecType } from '@stoqey/ib'
import { expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

it.each([
  ['cfd', SecType.CFD, 'MIDPOINT'],
  ['commodity', SecType.CMDTY, 'MIDPOINT'],
  ['fund', SecType.FUND, 'MIDPOINT'],
  ['futures', SecType.FUT, 'TRADES'],
  ['index', SecType.IND, 'TRADES'],
  ['warrant', SecType.WAR, 'TRADES'],
])(
  'requests %s history with its IBKR-supported data type',
  async (assetClass, secType, dataType) => {
    const ib = new EventEmitter()
    const reqHistoricalData = vi.fn((id: number, _contract: Contract) =>
      queueMicrotask(() => {
        ib.emit(EventName.historicalData, id, '20260910', 10, 12, 9, 11, -1, 0, 0)
        ib.emit(EventName.historicalData, id, '20260911', 11, 13, 10, 12, 0, 0, 0)
        ib.emit(EventName.historicalData, id, 'finished', 0, 0, 0, 0, 0, 0, 0)
      }),
    )
    Object.assign(ib, { reqHistoricalData, cancelHistoricalData: vi.fn() })
    const store = new BrokerStateStore()
    store.setConnectionStatus('connected')
    const service = new IbkrService(createBridgeConfig(loadGatewayConfig({})), store, ib as IBApi)
    const { bars } = await service.loadBars({
      symbol: 'IBKR:123',
      assetClass,
      exchange: 'SMART',
      currency: 'USD',
      interval: '1D',
      barCount: 5,
    })
    expect(bars).toHaveLength(2)
    expect(bars[0]).not.toHaveProperty('volume')
    expect(bars[1]?.volume).toBe(0)
    expect(reqHistoricalData).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ conId: 123, secType }),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      dataType,
      expect.any(Number),
      expect.any(Number),
      false,
    )
  },
)

it('returns no more than the requested number of newest historical bars', async () => {
  const ib = new EventEmitter()
  Object.assign(ib, {
    reqHistoricalData: vi.fn((id: number) =>
      queueMicrotask(() => {
        for (let day = 5; day <= 10; day += 1) {
          ib.emit(
            EventName.historicalData,
            id,
            `202609${String(day).padStart(2, '0')}`,
            day,
            day + 1,
            day - 1,
            day + 0.5,
            100,
            0,
            0,
          )
        }
        ib.emit(EventName.historicalData, id, 'finished', 0, 0, 0, 0, 0, 0, 0)
      }),
    ),
    cancelHistoricalData: vi.fn(),
  })
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const service = new IbkrService(createBridgeConfig(loadGatewayConfig({})), store, ib as IBApi)

  const { bars, hasOlder } = await service.loadBars({
    symbol: 'AAPL',
    assetClass: 'stock',
    exchange: 'SMART',
    currency: 'USD',
    interval: '1m',
    barCount: 5,
  })

  expect(bars).toHaveLength(5)
  expect(bars.map((bar) => bar.close)).toEqual([6.5, 7.5, 8.5, 9.5, 10.5])
  expect(hasOlder).toBe(true)
})

it('explains unanswered history with a competing live session only while a quote stream reports it', async () => {
  vi.useFakeTimers()
  try {
    const ib = Object.assign(new EventEmitter(), {
      reqMktData: vi.fn(),
      cancelMktData: vi.fn(),
      reqMarketDataType: vi.fn(),
      reqHistoricalData: vi.fn(),
      cancelHistoricalData: vi.fn(),
    })
    const store = new BrokerStateStore()
    store.setConnectionStatus('connected')
    const service = new IbkrService(
      createBridgeConfig(loadGatewayConfig({})),
      store,
      ib as unknown as IBApi,
    )
    const symbol = {
      symbol: 'AAPL',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      currency: 'USD',
      assetClass: 'stock',
    }
    const history = () => service.loadBars({ ...symbol, interval: '5m', barCount: 50 })
    const quoteId = () => ib.reqMktData.mock.calls.at(-1)?.[0] as number

    service.getQuotes([symbol])
    expect(service.competingLiveSessionReported()).toBe(false)
    ib.emit(
      EventName.error,
      new Error('No market data during competing live session'),
      10197,
      quoteId(),
    )
    expect(service.competingLiveSessionReported()).toBe(true)

    // The quote retry at 15 seconds keeps the reported cause on the new stream.
    const blocked = expect(history()).rejects.toMatchObject({
      statusCode: 503,
      code: 'market-data-competing-session',
      message: expect.stringContaining(
        'competing live session (IBKR 10197). Restart TWS or IB Gateway',
      ),
    })
    await vi.advanceTimersByTimeAsync(20_000)
    await blocked
    expect(service.competingLiveSessionReported()).toBe(true)

    ib.emit(EventName.tickPrice, quoteId(), 1, 250)
    expect(service.competingLiveSessionReported()).toBe(false)
    const timedOut = expect(history()).rejects.toMatchObject({
      statusCode: 504,
      code: 'market-data-timeout',
    })
    await vi.advanceTimersByTimeAsync(20_000)
    await timedOut
  } finally {
    vi.useRealTimers()
  }
})
