import { EventEmitter } from 'node:events'
import { BarSizeSetting, type ContractDetails, EventName, type IBApi, WhatToShow } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { deriveSessionWindows, toMarketSessionInfo } from '../src/ibkr/session-calendar.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

function fixture() {
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const emitter = new EventEmitter()
  const reqHistoricalData = vi.fn((...args: unknown[]) => {
    const requestId = args[0] as number
    const regularHoursOnly = args[6] as boolean
    queueMicrotask(() => {
      emitter.emit(
        EventName.historicalSchedule,
        requestId,
        '20260910-00:00:00',
        '20260911-11:27:25',
        'US/Eastern',
        [
          regularHoursOnly
            ? {
                startDateTime: '20260911-09:30:00',
                endDateTime: '20260911-16:00:00',
                refDate: '20260911',
              }
            : {
                startDateTime: '20260911-04:00:00',
                endDateTime: '20260911-20:00:00',
                refDate: '20260911',
              },
        ],
      )
    })
  })
  const reqMarketRule = vi.fn((marketRuleId: number) => {
    queueMicrotask(() =>
      emitter.emit(EventName.marketRule, marketRuleId, [
        { lowEdge: 0, increment: 0.01 },
        { lowEdge: 1, increment: 0.05 },
      ]),
    )
  })
  const ib = Object.assign(emitter, { reqHistoricalData, reqMarketRule })
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU123' })),
    store,
    ib as unknown as IBApi,
  )
  vi.spyOn(
    service as unknown as { requestContractDetails: () => Promise<ContractDetails[]> },
    'requestContractDetails',
  ).mockResolvedValue([
    {
      contract: {
        conId: 265598,
        symbol: 'AAPL',
        secType: 'STK',
        exchange: 'SMART',
        primaryExch: 'NASDAQ',
        currency: 'USD',
      },
      timeZoneId: 'US/Eastern',
      validExchanges: 'SMART,NASDAQ',
      marketRuleIds: '26,26',
    } as ContractDetails,
  ])
  return { service, reqHistoricalData, reqMarketRule }
}

describe('IBKR session calendar', () => {
  it('does not label a trading segment regular without overlapping liquid-hours evidence', () => {
    expect(
      deriveSessionWindows(
        [{ dateKey: '2026-09-14', opensAt: 100, closesAt: 200 }],
        [{ opensAt: 300, closesAt: 400 }],
      ),
    ).toEqual([{ opensAt: 100, closesAt: 200, state: 'extended' }])
    expect(
      deriveSessionWindows([{ dateKey: '2026-09-14', opensAt: 100, closesAt: 200 }], []),
    ).toEqual([{ opensAt: 100, closesAt: 200, state: 'unknown' }])
  })

  it('only infers an early close for a known US equity calendar', () => {
    const asOf = Date.parse('2026-09-14T06:00:00Z')
    const japan = toMarketSessionInfo(
      { ticker: '7203', exchange: 'TSEJ', currency: 'JPY', type: 'stock' },
      {
        contract: { symbol: '7203', exchange: 'TSEJ', currency: 'JPY' },
        timeZoneId: 'Japan',
        tradingHours: '20260914:0900-1530',
        liquidHours: '20260914:0900-1530',
      } as ContractDetails,
      asOf,
    )
    expect(japan.metadata?.earlyClose).toBeUndefined()

    const missing = toMarketSessionInfo(
      { ticker: 'UNKNOWN', exchange: 'SMART', currency: 'USD', type: 'stock' },
      { contract: { symbol: 'UNKNOWN', exchange: 'SMART', currency: 'USD' } } as ContractDetails,
      asOf,
    )
    expect(missing).toMatchObject({
      timezone: 'Etc/UTC',
      currentState: 'unknown',
      upcoming: [],
    })
  })

  it('derives pre-market, regular, and post-market windows from broker schedules', async () => {
    const { service, reqHistoricalData } = fixture()
    const calendar = await service.resolveSessionCalendar({
      symbol: 'AAPL',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      currency: 'USD',
      assetClass: 'stock',
      startTime: Date.parse('2026-09-10T04:00:00Z'),
      endTime: Date.parse('2026-09-11T22:00:00Z'),
    })

    expect(reqHistoricalData).toHaveBeenCalledTimes(2)
    for (const call of reqHistoricalData.mock.calls) {
      expect(call[4]).toBe(BarSizeSetting.DAYS_ONE)
      expect(call[5]).toBe(WhatToShow.SCHEDULE)
    }
    expect(reqHistoricalData.mock.calls.map((call) => call[6]).sort()).toEqual([false, true])
    expect(calendar).toEqual({
      symbol: expect.objectContaining({
        ticker: 'AAPL',
        exchange: 'SMART',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
      }),
      timezone: 'America/New_York',
      coverage: {
        startTime: Date.parse('2026-09-10T04:00:00Z'),
        endTime: Date.parse('2026-09-12T04:00:00Z'),
      },
      windows: [
        {
          opensAt: Date.parse('2026-09-11T08:00:00Z'),
          closesAt: Date.parse('2026-09-11T13:30:00Z'),
          state: 'pre-market',
        },
        {
          opensAt: Date.parse('2026-09-11T13:30:00Z'),
          closesAt: Date.parse('2026-09-11T20:00:00Z'),
          state: 'regular',
        },
        {
          opensAt: Date.parse('2026-09-11T20:00:00Z'),
          closesAt: Date.parse('2026-09-12T00:00:00Z'),
          state: 'post-market',
        },
      ],
      source: 'ibkr-historical-schedule',
    })
  })

  it('loads the route-specific price increment bands from the aligned market rule', async () => {
    const { service, reqMarketRule } = fixture()
    const session = await service.resolveSession({
      symbol: 'AAPL',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      currency: 'USD',
      assetClass: 'stock',
    })

    expect(reqMarketRule).toHaveBeenCalledWith(26)
    expect(session.symbol.priceIncrements).toEqual([
      { lowEdge: 0, increment: 0.01 },
      { lowEdge: 1, increment: 0.05 },
    ])
  })

  it('keeps price increments unknown when the selected market rule is unavailable', async () => {
    const { service } = fixture()
    const internal = service as unknown as {
      requests: { requestMarketRule: (id: number) => Promise<never> }
    }
    vi.spyOn(internal.requests, 'requestMarketRule').mockRejectedValue(
      new Error('Market rule unavailable'),
    )

    const session = await service.resolveSession({
      symbol: 'AAPL',
      exchange: 'SMART',
      currency: 'USD',
      assetClass: 'stock',
    })

    expect(session.symbol.priceIncrements).toBeUndefined()
    expect(session.symbol.minTick).toBeUndefined()
  })
})
