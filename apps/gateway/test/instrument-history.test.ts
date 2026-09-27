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
    const service = new IbkrService(
      createBridgeConfig(loadGatewayConfig({})),
      store,
      ib as IBApi,
      false,
    )
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
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({})),
    store,
    ib as IBApi,
    false,
  )

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
