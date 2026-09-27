import { EventEmitter } from 'node:events'
import { BarSizeSetting, EventName, type IBApi, SecType } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IbkrRequests } from '../src/ibkr/ibkr-requests.js'
import { RequestError } from '../src/ibkr/request-error.js'

function fixture(onRequest?: (ib: EventEmitter, reqId: number) => void) {
  const ib = new EventEmitter()
  const reqHistoricalData = vi.fn((reqId: number) => onRequest?.(ib, reqId))
  const cancelHistoricalData = vi.fn()
  Object.assign(ib, { reqHistoricalData, cancelHistoricalData })
  return {
    ib,
    requests: new IbkrRequests(ib as IBApi, () => true),
    reqHistoricalData,
    cancelHistoricalData,
  }
}

const contract = {
  conId: 265598,
  symbol: 'AAPL',
  secType: SecType.STK,
  exchange: 'SMART',
  currency: 'USD',
}

afterEach(() => {
  vi.useRealTimers()
})

describe('IBKR historical request lifecycle and pacing', () => {
  it('finishes on the SDK adapter event that represents historicalDataEnd', async () => {
    const { requests } = fixture((ib, reqId) =>
      queueMicrotask(() => {
        ib.emit(EventName.historicalData, reqId, '20260911', 10, 11, 9, 10.5, 100)
        // @stoqey/ib maps TWS historicalDataEnd to this terminal historicalData marker.
        ib.emit(EventName.historicalData, reqId, 'finished', -1, -1, -1, -1, -1)
      }),
    )

    await expect(
      requests.requestHistoricalBars(contract, {
        endDateTime: '20260911 16:00:00 UTC',
        duration: '1 D',
        barSize: BarSizeSetting.MINUTES_ONE,
      }),
    ).resolves.toHaveLength(1)
  })

  it('rejects an identical small-bar request inside fifteen seconds before sending it', async () => {
    vi.useFakeTimers()
    const { requests, reqHistoricalData } = fixture((ib, reqId) =>
      queueMicrotask(() =>
        ib.emit(EventName.historicalData, reqId, 'finished', -1, -1, -1, -1, -1),
      ),
    )
    const request = {
      endDateTime: '20260911 16:00:00 UTC',
      duration: '1 D',
      barSize: BarSizeSetting.SECONDS_FIVE,
    }

    await requests.requestHistoricalBars(contract, request)
    expect(() => requests.requestHistoricalBars(contract, request)).toThrowError(RequestError)
    try {
      requests.requestHistoricalBars(contract, request)
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 429 })
    }
    expect(reqHistoricalData).toHaveBeenCalledTimes(1)
  })

  it('shares the sixty-request small-bar budget across distinct chart requests', async () => {
    vi.useFakeTimers()
    const { requests, reqHistoricalData } = fixture((ib, reqId) =>
      queueMicrotask(() =>
        ib.emit(EventName.historicalData, reqId, 'finished', -1, -1, -1, -1, -1),
      ),
    )

    for (let index = 0; index < 60; index += 1) {
      await requests.requestHistoricalBars(
        { ...contract, conId: contract.conId + index },
        {
          endDateTime: `20260911 16:${String(index).padStart(2, '0')}:00 UTC`,
          duration: '1 D',
          barSize: BarSizeSetting.SECONDS_THIRTY,
        },
      )
    }

    expect(() =>
      requests.requestHistoricalBars(
        { ...contract, conId: 999999 },
        {
          endDateTime: '20260911 17:01:00 UTC',
          duration: '1 D',
          barSize: BarSizeSetting.SECONDS_THIRTY,
        },
      ),
    ).toThrowError(/shared 60-request small-bar budget/u)
    expect(reqHistoricalData).toHaveBeenCalledTimes(60)
  })

  it('cancels a timed-out historical bar request in TWS', async () => {
    vi.useFakeTimers()
    const { requests, cancelHistoricalData } = fixture()
    const result = requests.requestHistoricalBars(contract, {
      endDateTime: '20260911 16:00:00 UTC',
      duration: '1 D',
      barSize: BarSizeSetting.MINUTES_ONE,
    })

    const rejection = expect(result).rejects.toMatchObject({ statusCode: 504 })
    await vi.advanceTimersByTimeAsync(20_000)
    await rejection
    expect(cancelHistoricalData).toHaveBeenCalledWith(expect.any(Number))
  })

  it('surfaces a TWS historical pacing error as an HTTP-style 429', async () => {
    const { requests } = fixture((ib, reqId) =>
      queueMicrotask(() =>
        ib.emit(EventName.error, new Error('Historical data request pacing violation'), 162, reqId),
      ),
    )

    await expect(
      requests.requestHistoricalBars(contract, {
        endDateTime: '20260911 16:00:00 UTC',
        duration: '1 D',
        barSize: BarSizeSetting.MINUTES_ONE,
      }),
    ).rejects.toMatchObject({ statusCode: 429 })
  })
})
