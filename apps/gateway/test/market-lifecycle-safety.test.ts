import { EventEmitter } from 'node:events'
import { BarSizeSetting, EventName, type IBApi, SecType } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBrokerRuntime } from '../src/connections/broker-runtime.js'
import { IbkrRequests } from '../src/ibkr/ibkr-requests.js'
import { OptionQuoteStreams } from '../src/ibkr/option-quote-streams.js'

const symbol = { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' }
const runtimes: ReturnType<typeof createBrokerRuntime>[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
})

function runtimeFixture() {
  vi.useFakeTimers()
  const api = Object.assign(new EventEmitter(), {
    isConnected: false,
    connect: vi.fn(() => {
      api.isConnected = true
    }),
    disconnect: vi.fn(() => {
      api.isConnected = false
      api.emit(EventName.disconnected)
    }),
    reqManagedAccts: vi.fn(),
    reqAccountSummary: vi.fn(),
    cancelAccountSummary: vi.fn(),
    reqPositions: vi.fn(),
    reqAllOpenOrders: vi.fn(),
    reqCompletedOrders: vi.fn(),
    reqExecutions: vi.fn(),
    reqIds: vi.fn(),
    reqMarketDataType: vi.fn(),
    reqAccountUpdates: vi.fn(),
    reqPnL: vi.fn(),
    cancelPnL: vi.fn(),
    reqMktData: vi.fn(),
    cancelMktData: vi.fn(),
    reqMktDepth: vi.fn(),
    cancelMktDepth: vi.fn(),
  })
  const runtime = createBrokerRuntime(
    loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU-TEST' }),
    vi.fn(),
    api as unknown as IBApi,
  )
  runtimes.push(runtime)
  runtime.start()
  const begin = () => {
    api.emit(EventName.connected)
    api.emit(EventName.managedAccounts, 'DU-TEST')
    api.emit(EventName.nextValidId, 100)
  }
  const finish = () => {
    api.emit(EventName.accountSummaryEnd, api.reqAccountSummary.mock.calls.at(-1)?.[0])
    api.emit(EventName.positionEnd)
    api.emit(EventName.openOrderEnd)
    api.emit(EventName.completedOrdersEnd)
    api.emit(EventName.execDetailsEnd, api.reqExecutions.mock.calls.at(-1)?.[0])
  }
  begin()
  finish()
  return { api, runtime, begin, finish }
}

describe('desired market subscriptions across socket generations', () => {
  it('invalidates depth immediately and restores its desired request only after complete readiness', () => {
    const { api, runtime, begin, finish } = runtimeFixture()
    runtime.ibkr.getMarketDepth(symbol, 8)
    const oldId = api.reqMktDepth.mock.calls.at(-1)?.[0]
    api.emit(EventName.updateMktDepth, oldId, 0, 0, 1, 100, 20)
    expect(runtime.brokerStore.getState().marketDepths?.[0]?.bids).toHaveLength(1)
    api.emit(EventName.disconnected)
    expect(runtime.brokerStore.getState().marketDepths?.[0]).toMatchObject({
      bids: [],
      asks: [],
      diagnostic: { message: expect.stringMatching(/disconnect|unavailable/i) },
    })
    api.emit(EventName.updateMktDepth, oldId, 0, 0, 1, 999, 20)
    expect(runtime.brokerStore.getState().marketDepths?.[0]?.bids).toEqual([])
    begin()
    expect(api.reqMktDepth).toHaveBeenCalledTimes(1)
    finish()
    expect(api.reqMktDepth).toHaveBeenCalledTimes(2)
    const newId = api.reqMktDepth.mock.calls.at(-1)?.[0]
    expect(newId).not.toBe(oldId)
    expect(api.reqMktDepth.mock.calls.at(-1)?.[2]).toBe(8)
    api.emit(EventName.updateMktDepth, oldId, 0, 0, 1, 999, 20)
    expect(runtime.brokerStore.getState().marketDepths?.[0]?.bids).toEqual([])
    api.emit(EventName.updateMktDepth, newId, 0, 0, 1, 101, 30)
    expect(runtime.brokerStore.getState().marketDepths?.[0]?.bids).toEqual([{ price: 101, size: 30 }])
  })

  it('preserves an option SSE owner through disconnect and ignores late prices before a fresh ready stream', () => {
    const { api, runtime, begin, finish } = runtimeFixture()
    const internal = runtime.ibkr as unknown as {
      options: { optionQuoteStreams: OptionQuoteStreams }
    }
    const streams = internal.options.optionQuoteStreams
    const listener = vi.fn()
    const unsubscribe = streams.subscribeMany([{ conId: 20 }], listener)
    const oldId = api.reqMktData.mock.calls.at(-1)?.[0] as number
    api.emit(EventName.tickPrice, oldId, 1, 2)
    expect(listener).toHaveBeenLastCalledWith({ conId: 20 }, expect.objectContaining({ bid: 2 }))
    api.emit(EventName.disconnected)
    expect(listener).toHaveBeenLastCalledWith({ conId: 20 }, {})
    begin()
    expect(api.reqMktData).toHaveBeenCalledTimes(1)
    finish()
    const newId = api.reqMktData.mock.calls.at(-1)?.[0] as number
    expect(newId).not.toBe(oldId)
    api.emit(EventName.tickPrice, oldId, 1, 99)
    expect(listener).toHaveBeenLastCalledWith({ conId: 20 }, {})
    vi.advanceTimersByTime(30_000)
    expect(streams.has(newId)).toBe(true)
    api.emit(EventName.tickPrice, newId, 1, 3)
    expect(listener).toHaveBeenLastCalledWith({ conId: 20 }, expect.objectContaining({ bid: 3 }))
    unsubscribe()
    vi.advanceTimersByTime(15_000)
    expect(streams.has(newId)).toBe(false)
  })

  it('keeps a closed old-generation option owner from releasing a newer owner of the same contract', () => {
    let id = 0
    vi.useFakeTimers()
    const streams = new OptionQuoteStreams(vi.fn(), vi.fn(), () => ++id)
    const oldRelease = streams.subscribeMany([{ conId: 20 }], vi.fn())
    streams.clear()
    const release = streams.subscribeMany([{ conId: 20 }], vi.fn())
    oldRelease()
    vi.advanceTimersByTime(30_000)
    expect(streams.has(2)).toBe(true)
    release()
    vi.advanceTimersByTime(15_000)
    expect(streams.has(2)).toBe(false)
  })

  it('invalidates the explicit 2100 portfolio unsubscribe and allows a subsequent refresh to renew it', () => {
    const { api, runtime } = runtimeFixture()
    api.emit(
      EventName.updatePortfolio,
      { conId: 1, symbol: 'AAPL', secType: SecType.STK, exchange: 'SMART', currency: 'USD' },
      2,
      100,
      200,
      80,
      40,
      0,
      'DU-TEST',
    )
    const before = api.reqAccountUpdates.mock.calls.length
    api.emit(EventName.info, 'API client has been unsubscribed from account data.', 2100)
    const position = runtime.brokerStore.getState().positions[0]
    expect(position?.markPrice).toBeUndefined()
    expect(position?.marketValue).toBeUndefined()
    expect(position?.unrealizedPnl).toBeUndefined()
    expect(runtime.tws.snapshot().state).toBe('ready')
    api.emit(
      EventName.accountSummary,
      api.reqAccountSummary.mock.calls.at(-1)?.[0],
      'DU-TEST',
      'NetLiquidation',
      '5000',
      'USD',
    )
    expect(api.reqAccountUpdates.mock.calls.length).toBe(before + 1)
    expect(api.reqAccountUpdates).toHaveBeenLastCalledWith(true, 'DU-TEST')
  })

  it('decodes delayed high and low without marking them as current live prices', () => {
    const { api, runtime } = runtimeFixture()
    runtime.ibkr.getQuotes([symbol])
    const id = api.reqMktData.mock.calls.at(-1)?.[0]
    api.emit(EventName.tickPrice, id, 72, 105)
    api.emit(EventName.tickPrice, id, 73, 95)
    expect(runtime.ibkr.getQuotes([symbol])[0]).toMatchObject({ high: 105, low: 95 })
    expect(runtime.ibkr.getQuotes([symbol])[0]?.status).not.toBe('ok')
    api.emit(EventName.tickPrice, id, 66, 100)
    expect(runtime.ibkr.getQuotes([symbol])[0]).toMatchObject({
      high: 105,
      low: 95,
      status: 'delayed',
    })
  })

  it('expires abandoned quotes without ticks extending their lifetime and transparently starts a later read afresh', () => {
    const { api, runtime } = runtimeFixture()
    runtime.ibkr.getQuotes([symbol])
    const oldId = api.reqMktData.mock.calls.at(-1)?.[0]
    api.emit(EventName.tickPrice, oldId, 1, 100)
    vi.advanceTimersByTime(45_000)
    runtime.ibkr.getQuotes([symbol])
    vi.advanceTimersByTime(59_999)
    api.emit(EventName.tickPrice, oldId, 1, 101)
    expect(api.cancelMktData).not.toHaveBeenCalledWith(oldId)
    vi.advanceTimersByTime(1)
    expect(api.cancelMktData).toHaveBeenCalledWith(oldId)
    expect(runtime.brokerStore.getState().quotes[0]).toMatchObject({ status: 'unavailable' })
    expect(runtime.brokerStore.getState().quotes[0]?.bid).toBeUndefined()
    expect(runtime.ibkr.getQuotes([symbol])[0]?.bid).toBeUndefined()
    const newId = api.reqMktData.mock.calls.at(-1)?.[0]
    expect(newId).not.toBe(oldId)
    api.emit(EventName.tickPrice, oldId, 1, 999)
    expect(runtime.ibkr.getQuotes([symbol])[0]?.bid).toBeUndefined()
    api.emit(EventName.tickPrice, newId, 1, 102)
    expect(runtime.ibkr.getQuotes([symbol])[0]?.bid).toBe(102)
  })

  it('does not restore an abandoned quote after its disconnected desired lifetime expires', () => {
    const { api, runtime, begin, finish } = runtimeFixture()
    runtime.ibkr.getQuotes([symbol])
    api.emit(EventName.disconnected)
    vi.advanceTimersByTime(60_000)
    begin()
    finish()
    expect(api.reqMktData).toHaveBeenCalledTimes(1)
  })

  it('cancels old maintained-data streams on upstream loss and waits for readiness before replacement', () => {
    const { api, runtime, finish } = runtimeFixture()
    runtime.ibkr.getQuotes([symbol])
    const quoteId = api.reqMktData.mock.calls.at(-1)?.[0]
    api.emit(EventName.tickPrice, quoteId, 1, 100)
    const streams = (
      runtime.ibkr as unknown as { options: { optionQuoteStreams: OptionQuoteStreams } }
    ).options.optionQuoteStreams
    const release = streams.subscribeMany([{ conId: 20 }], vi.fn())
    const optionId = api.reqMktData.mock.calls.at(-1)?.[0]
    runtime.ibkr.getMarketDepth(symbol)
    const depthId = api.reqMktDepth.mock.calls.at(-1)?.[0]
    api.emit(EventName.info, 'Connectivity lost', 1100)
    expect(api.cancelMktData).toHaveBeenCalledWith(quoteId)
    expect(api.cancelMktData).toHaveBeenCalledWith(optionId)
    expect(api.cancelMktDepth).toHaveBeenCalledWith(depthId, true)
    api.emit(EventName.info, 'Connectivity restored - data maintained', 1102)
    api.emit(EventName.nextValidId, 200)
    expect(api.reqMktData).toHaveBeenCalledTimes(2)
    expect(api.reqMktDepth).toHaveBeenCalledTimes(1)
    finish()
    expect(api.reqMktData).toHaveBeenCalledTimes(4)
    expect(api.reqMktDepth).toHaveBeenCalledTimes(2)
    release()
  })
})

describe('provider history boundaries', () => {
  function requestsFixture() {
    const api = Object.assign(new EventEmitter(), {
      reqHistoricalData: vi.fn(),
      cancelHistoricalData: vi.fn(),
    })
    return { api, requests: new IbkrRequests(api as unknown as IBApi, () => true) }
  }
  it('treats recognizable HMDS no-data as an empty completed request and ignores late bars', async () => {
    const { api, requests } = requestsFixture()
    const result = requests.requestHistoricalBars(
      { conId: 1 },
      { endDateTime: '', duration: '1 D', barSize: BarSizeSetting.DAYS_ONE },
    )
    const id = api.reqHistoricalData.mock.calls[0]?.[0]
    api.emit(
      EventName.error,
      new Error(
        'Historical Market Data Service error message:HMDS query returned no data: AAPL@SMART Trades',
      ),
      162,
      id,
    )
    await expect(result).resolves.toEqual([])
    api.emit(EventName.historicalData, id, '20260929', 1, 2, 1, 2, 100)
    expect(api.listenerCount(EventName.historicalData)).toBe(0)
    expect(api.listenerCount(EventName.error)).toBe(0)
  })
  it.each([
    ['Historical data request pacing violation', 429],
    ['Historical Market Data Service connection broken', 503],
  ])('preserves 162 failure for %s', async (message, statusCode) => {
    const { api, requests } = requestsFixture()
    const result = requests.requestHistoricalBars(
      { conId: 1, symbol: 'AAPL' },
      { endDateTime: '', duration: '1 D', barSize: BarSizeSetting.DAYS_ONE },
    )
    api.emit(EventName.error, new Error(message), 162, api.reqHistoricalData.mock.calls[0]?.[0])
    await expect(result).rejects.toMatchObject({
      statusCode,
      code: 'market-data-rejected',
      message: `IBKR rejected the chart history request for AAPL: ${message} (IBKR 162)`,
    })
  })
  it('reports an unanswered history request as a typed timeout and cancels it', async () => {
    vi.useFakeTimers()
    try {
      const { api, requests } = requestsFixture()
      const result = requests.requestHistoricalBars(
        { conId: 1, symbol: 'AAPL' },
        { endDateTime: '', duration: '1 D', barSize: BarSizeSetting.DAYS_ONE },
      )
      const assertion = expect(result).rejects.toMatchObject({
        statusCode: 504,
        code: 'market-data-timeout',
        message:
          'IBKR accepted the chart history request for AAPL but sent no data within 20 seconds. If this continues, restart TWS or IB Gateway and log in again.',
      })
      await vi.advanceTimersByTimeAsync(20_000)
      await assertion
      expect(api.cancelHistoricalData).toHaveBeenCalledWith(
        api.reqHistoricalData.mock.calls[0]?.[0],
      )
      expect(api.listenerCount(EventName.historicalData)).toBe(0)
      expect(api.listenerCount(EventName.error)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps calendar coverage at the returned broker boundary instead of extending the reference day', async () => {
    const { api, requests } = requestsFixture()
    const result = requests.requestHistoricalSchedule(
      { conId: 1 },
      Date.parse('2026-09-29T00:00:00Z'),
      Date.parse('2026-09-30T12:00:00Z'),
      false,
    )
    api.emit(
      EventName.historicalSchedule,
      api.reqHistoricalData.mock.calls[0]?.[0],
      '20260929-00:00:00',
      '20260930-11:30:00',
      'Etc/UTC',
      [
        {
          startDateTime: '20260930-09:30:00',
          endDateTime: '20260930-16:00:00',
          refDate: '20260930',
        },
      ],
    )
    await expect(result).resolves.toMatchObject({
      startTime: Date.parse('2026-09-29T00:00:00Z'),
      endTime: Date.parse('2026-09-30T11:30:00Z'),
    })
  })
})
