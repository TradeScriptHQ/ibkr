import { EventEmitter } from 'node:events'
import { EventName, type IBApi, SecType } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { toIbContract } from '../src/ibkr/contracts.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { MarketDataConnectionTracker } from '../src/ibkr/market-data-connection.js'
import { selectOptionParameters } from '../src/ibkr/option-chain.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
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
  store.setAccounts([{ id: 'DU-TEST', label: 'Test', currency: 'USD' }])
  const api = Object.assign(new EventEmitter(), {
    reqTickByTickData: vi.fn(),
    cancelTickByTickData: vi.fn(),
    reqAccountUpdates: vi.fn(),
    reqPnL: vi.fn(),
    cancelPnL: vi.fn(),
    placeOrder: vi.fn(),
    reqIds: vi.fn(),
  })
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU-TEST' })),
    store,
    api as unknown as IBApi,
  )
  api.emit(EventName.nextValidId, 50)
  return { api, store, service }
}

describe('second gateway semantic review', () => {
  it.each([
    { contractIdentity: { conId: 0, securityType: 'STK' } },
    { contractIdentity: { conId: -1, securityType: 'STK' } },
    { contractIdentity: { conId: 265598, securityType: 'OPT' } },
    { contractIdentity: { conId: 265598, securityType: 'STK' }, canonicalSymbol: 'IBKR:1' },
    { contractIdentity: { conId: 265598, securityType: 'STK' }, symbol: 'IBKR:1' },
  ])('rejects contradictory or invalid stock contract identity %j', (identity) => {
    expect(() => toIbContract({ ...symbol, ...identity }, 'day', 'SMART')).toThrow(
      /matching exact IBKR identity/,
    )
  })
  it('retains qualified stock identity while preserving natural stock requests', () => {
    expect(toIbContract(symbol)).toMatchObject({
      symbol: 'AAPL',
      secType: 'STK',
      exchange: 'SMART',
    })
    expect(toIbContract(symbol)).not.toHaveProperty('conId')
    expect(
      toIbContract({ ...symbol, symbol: 'IBKR:265598', canonicalSymbol: 'IBKR:265598' }),
    ).toMatchObject({ conId: 265598, secType: 'STK', exchange: 'SMART' })
    expect(
      toIbContract({ ...symbol, symbol: 'IBKR:265598', canonicalSymbol: 'IBKR:265598' }),
    ).not.toHaveProperty('symbol')
  })
  it('clears only the named failed farm after its canonical inactive period suffix', () => {
    const tracker = new MarketDataConnectionTracker()
    tracker.handle(2103, 'Market data farm connection is broken:usfarm.nj')
    tracker.handle(2103, 'Market data farm connection is broken:cashfarm')
    expect(
      tracker.handle(
        2108,
        'Market data farm connection is inactive but should be available upon demand.usfarm.nj',
      ),
    ).toMatchObject({ status: 'degraded', message: 'Market data disconnected: cashfarm' })
    expect(tracker.handle(2104, 'Market data farm connection is OK:cashfarm')).toMatchObject({
      status: 'connected',
    })
  })
  it('does not invent a recovered farm when an inactive notice omits the farm name', () => {
    const tracker = new MarketDataConnectionTracker()
    tracker.handle(2103, 'Market data farm connection is broken:usfarm')
    expect(
      tracker.handle(
        2108,
        'Market data farm connection is inactive but should be available upon demand.',
      ),
    ).toMatchObject({ status: 'degraded', message: 'Market data disconnected: usfarm' })
  })
  it('surfaces tape failure through a cooldown, retries with a fresh ID and ignores the old request', () => {
    const { api, service } = fixture()
    expect(service.getTimeAndSales(symbol)).toEqual([])
    const firstId = api.reqTickByTickData.mock.calls.at(-1)?.[0]
    api.emit(
      EventName.error,
      new Error('Tick-by-tick market data is not subscribed'),
      10089,
      firstId,
    )
    expect(() => service.getTimeAndSales(symbol)).toThrow(
      'Tick-by-tick market data is not subscribed',
    )
    for (let tick = 0; tick < 10; tick += 1) expect(() => service.getTimeAndSales(symbol)).toThrow()
    expect(api.reqTickByTickData).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(15_000)
    expect(() => service.getTimeAndSales(symbol)).toThrow()
    expect(api.reqTickByTickData).toHaveBeenCalledTimes(2)
    const retryId = api.reqTickByTickData.mock.calls.at(-1)?.[0]
    expect(retryId).not.toBe(firstId)
    api.emit(EventName.tickByTickAllLast, firstId, 1, '1790762400', 999, 1, {}, 'NYSE', '')
    expect(() => service.getTimeAndSales(symbol)).toThrow()
    api.emit(EventName.tickByTickAllLast, retryId, 1, '1790762400', 101, 2, {}, 'NYSE', '')
    expect(service.getTimeAndSales(symbol)).toEqual([
      expect.objectContaining({ price: 101, size: 2 }),
    ])
  })
  it('does not let one symbol tape failure suppress a newly selected symbol', () => {
    const { api, service } = fixture()
    service.getTimeAndSales(symbol)
    api.emit(
      EventName.error,
      new Error('Tick-by-tick limit reached'),
      10190,
      api.reqTickByTickData.mock.calls.at(-1)?.[0],
    )
    expect(service.getTimeAndSales({ ...symbol, symbol: 'MSFT' })).toEqual([])
    expect(api.reqTickByTickData).toHaveBeenCalledTimes(2)
  })
  it('cancels the previous tape request when complete reconciliation restores it', () => {
    const { api, service } = fixture()
    service.getTimeAndSales(symbol)
    const oldId = api.reqTickByTickData.mock.calls.at(-1)?.[0]
    service.setMarketDataReady(false)
    service.setMarketDataReady(true)
    expect(api.cancelTickByTickData).toHaveBeenCalledWith(oldId)
    const restoredId = api.reqTickByTickData.mock.calls.at(-1)?.[0]
    expect(restoredId).not.toBe(oldId)
    api.emit(EventName.tickByTickAllLast, oldId, 1, '1790762400', 999, 1, {}, 'NYSE', '')
    expect(service.getTimeAndSales(symbol)).toEqual([])
  })
  it('backs repeated tape failures off to a capped sixty-second retry cadence', () => {
    const { api, service } = fixture()
    service.getTimeAndSales(symbol)
    for (const delay of [15_000, 30_000, 60_000, 60_000]) {
      api.emit(
        EventName.error,
        new Error('Tick-by-tick limit reached'),
        10190,
        api.reqTickByTickData.mock.calls.at(-1)?.[0],
      )
      const count = api.reqTickByTickData.mock.calls.length
      vi.advanceTimersByTime(delay - 1)
      expect(() => service.getTimeAndSales(symbol)).toThrow()
      expect(api.reqTickByTickData).toHaveBeenCalledTimes(count)
      vi.advanceTimersByTime(1)
      expect(() => service.getTimeAndSales(symbol)).toThrow()
      expect(api.reqTickByTickData).toHaveBeenCalledTimes(count + 1)
    }
  })
  it('refuses to choose the first option class when the same route has multiple exact classes', () => {
    const base = {
      exchange: 'SMART',
      underlyingConId: 1,
      multiplier: '100',
      expirations: ['20261016'],
      strikes: [5000],
    }
    expect(() =>
      selectOptionParameters(
        [
          { ...base, tradingClass: 'SPX' },
          { ...base, tradingClass: 'SPXW' },
        ],
        'SMART',
      ),
    ).toThrow(/multiple.*trading classes/i)
  })
  it('preserves one exact class when the provider repeats its parameters on listing and SMART routes', () => {
    const base = {
      underlyingConId: 1,
      multiplier: '100',
      expirations: ['20261016'],
      strikes: [100],
      tradingClass: 'AAPL',
    }
    expect(
      selectOptionParameters(
        [
          { ...base, exchange: 'CBOE' },
          { ...base, exchange: 'SMART' },
        ],
        '',
      )?.exchange,
    ).toBe('SMART')
  })
  it.each(['OVERNIGHT', 'NYSE', 'ARCA'])(
    'defaults stock closes to SMART after a %s callback route',
    async (exchange) => {
      const { api, store, service } = fixture()
      api.emit(
        EventName.position,
        'DU-TEST',
        {
          conId: 265598,
          symbol: 'AAPL',
          secType: SecType.STK,
          exchange,
          primaryExch: 'NASDAQ',
          currency: 'USD',
        },
        1,
        90,
      )
      const position = store.getState().positions[0]
      if (!position) throw new Error('Position missing')
      const internal = service as unknown as {
        orders: {
          positionCloseDraft: (id: string, context: object, options: object) => Promise<unknown>
        }
      }
      await expect(internal.orders.positionCloseDraft(position.id, {}, {})).resolves.toMatchObject({
        symbol: { contractIdentity: { conId: 265598 }, primaryExchange: 'NASDAQ' },
        routingDestination: 'SMART',
        type: 'market',
        duration: 'day',
      })
    },
  )
  it('sends the exact overnight-stock close preview to SMART as MKT DAY', async () => {
    const { api, store, service } = fixture()
    vi.spyOn(service['requests'], 'requestContractDetails').mockImplementation(async (contract) => [
      {
        contract: { ...contract, conId: 265598 },
        priceMagnifier: 1,
        validExchanges: 'SMART',
        marketRuleIds: '26',
      },
    ])
    api.emit(
      EventName.position,
      'DU-TEST',
      {
        conId: 265598,
        symbol: 'AAPL',
        secType: SecType.STK,
        exchange: 'OVERNIGHT',
        primaryExch: 'NASDAQ',
        currency: 'USD',
      },
      2,
      90,
    )
    const position = store.getState().positions[0]
    if (!position) throw new Error('Position missing')
    const preview = service.previewClosePosition(position.id)
    await vi.advanceTimersByTimeAsync(0)
    const request = api.placeOrder.mock.calls[0]
    expect(request?.[1]).toMatchObject({ conId: 265598, exchange: 'SMART', primaryExch: 'NASDAQ' })
    expect(request?.[2]).toMatchObject({
      orderType: 'MKT',
      action: 'SELL',
      tif: 'DAY',
      totalQuantity: 2,
      whatIf: true,
    })
    api.emit(EventName.openOrder, request?.[0], request?.[1], request?.[2], { commission: 1 })
    await expect(preview).resolves.toMatchObject({ accepted: true, source: 'broker' })
  })
})
