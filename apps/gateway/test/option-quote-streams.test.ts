import { IBApiTickType } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OptionQuoteStreams } from '../src/ibkr/option-quote-streams.js'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers()
  let id = 0
  const start = vi.fn()
  const cancel = vi.fn()
  const streams = new OptionQuoteStreams(start, cancel, () => ++id, 15_000)
  return { streams, start, cancel }
}

describe('persistent option quotes', () => {
  it('returns partial quotes after the deadline and releases the next expiry', async () => {
    const { streams, start } = fixture()
    const first = streams.readManyReady([{ conId: 1 }])
    const second = streams.readManyReady([{ conId: 2 }])
    await vi.advanceTimersByTimeAsync(0)
    streams.price(1, 66, 1.25)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await first).toEqual([expect.objectContaining({ bid: 1.25 })])
    expect(start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await second).toEqual([{}])
    streams.clear()
  })

  it('lets concurrent expiry windows receive their ticks before another window evicts them', async () => {
    const { streams, start } = fixture()
    const first = streams.readManyReady([{ conId: 1 }])
    const second = streams.readManyReady([{ conId: 2 }])
    await vi.advanceTimersByTimeAsync(0)
    expect(start).toHaveBeenCalledTimes(1)
    streams.price(1, 66, 1.25)
    streams.price(1, 67, 1.3)
    expect(await first).toEqual([expect.objectContaining({ bid: 1.25, ask: 1.3 })])
    await vi.advanceTimersByTimeAsync(0)
    streams.price(2, 66, 2.25)
    streams.price(2, 67, 2.3)
    expect(await second).toEqual([expect.objectContaining({ bid: 2.25, ask: 2.3 })])
    streams.clear()
  })
  it('returns subsequent ticks without reopening subscriptions or mutating earlier snapshots', () => {
    const { streams, start } = fixture()
    const contract = { conId: 123 }
    const first = streams.read(contract)
    streams.price(1, 66, 1.25)
    streams.price(1, 67, 1.3)
    streams.size(1, 74, 100)
    expect(streams.read(contract)).toMatchObject({ bid: 1.25, ask: 1.3, volume: 100 })
    streams.price(1, 66, 1.27)
    expect(streams.read(contract).bid).toBe(1.27)
    expect(first).toEqual({})
    expect(start).toHaveBeenCalledTimes(1)
    streams.clear()
  })

  it('uses the paired size tick to distinguish a valid zero from an unavailable price', () => {
    const { streams } = fixture()
    streams.read({ conId: 1 })
    streams.price(1, 1, 1.25)
    streams.size(1, 0, 10)
    streams.price(1, 1, 0)
    expect(streams.read({ conId: 1 }).bid).toBe(1.25)
    streams.size(1, 0, 0)
    expect(streams.read({ conId: 1 }).bid).toBeUndefined()
    streams.price(1, 1, 0)
    streams.size(1, 0, 5)
    expect(streams.read({ conId: 1 }).bid).toBe(0)
    streams.price(1, 1, -1)
    streams.size(1, 0, 0)
    expect(streams.read({ conId: 1 }).bid).toBeUndefined()
    streams.clear()
  })

  it('preserves the feed type and timestamps only actual option quote events', () => {
    const { streams } = fixture()
    vi.setSystemTime('2026-09-13T10:00:00Z')
    streams.read({ conId: 1 })
    streams.dataType(1, 4)
    expect(streams.read({ conId: 1 })).toEqual({ marketDataType: 'delayed-frozen' })
    vi.advanceTimersByTime(1000)
    streams.price(1, 1, 1.25)
    const quote = streams.read({ conId: 1 })
    expect(quote).toEqual({
      bid: 1.25,
      marketDataType: 'delayed-frozen',
      quoteTimestamp: '2026-09-13T10:00:01.000Z',
    })
    vi.advanceTimersByTime(1000)
    streams.dataType(1, 3)
    expect(streams.read({ conId: 1 }).quoteTimestamp).toBe(quote.quoteTimestamp)
    streams.clear()
  })

  it('uses TWS model computations for the canonical option Greeks', () => {
    const { streams } = fixture()
    vi.setSystemTime('2026-09-15T19:30:00Z')
    streams.read({ conId: 1 })

    streams.computation(1, IBApiTickType.BID_OPTION, 0.2, 0.4, 1.1, 0.03, 0.08, -0.12)
    expect(streams.read({ conId: 1 })).toEqual({})

    streams.computation(1, IBApiTickType.MODEL_OPTION, 0.21, 0.45, 1.2, 0.031, 0.081, -0.13)
    expect(streams.read({ conId: 1 })).toEqual({
      impliedVolatility: 0.21,
      delta: 0.45,
      mark: 1.2,
      gamma: 0.031,
      vega: 0.081,
      theta: -0.13,
      quoteTimestamp: '2026-09-15T19:30:00.000Z',
    })

    streams.computation(1, IBApiTickType.MODEL_OPTION)
    expect(streams.read({ conId: 1 })).toEqual({
      quoteTimestamp: '2026-09-15T19:30:00.000Z',
    })
    streams.clear()
  })

  it('expires streams when refreshing stops and renews active streams', () => {
    const { streams, cancel } = fixture()
    streams.read({ conId: 1 })
    vi.advanceTimersByTime(10_000)
    streams.read({ conId: 1 })
    vi.advanceTimersByTime(10_000)
    expect(cancel).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000)
    expect(cancel).toHaveBeenCalledWith(1)
    expect(streams.has(1)).toBe(false)
  })

  it('pushes matching ticks and retains subscribed contracts until release', () => {
    const { streams, cancel } = fixture()
    const first = { conId: 1 }
    const second = { conId: 2 }
    const listener = vi.fn()
    const unsubscribe = streams.subscribeMany([first], listener)

    streams.price(1, 1, 1.25)
    streams.readMany([second])
    vi.advanceTimersByTime(15_000)

    expect(listener).toHaveBeenLastCalledWith(first, expect.objectContaining({ bid: 1.25 }))
    expect(streams.has(1)).toBe(true)
    expect(cancel).not.toHaveBeenCalledWith(1)

    unsubscribe()
    vi.advanceTimersByTime(15_000)
    expect(streams.has(1)).toBe(false)
    expect(cancel).toHaveBeenCalledWith(1)
  })

  it('invalidates quotes and request IDs while restoring active streams after data loss', () => {
    const { streams, start } = fixture()
    const first = { conId: 1, exchange: 'SMART', currency: 'USD' }
    const second = { conId: 2, exchange: 'SMART', currency: 'USD' }
    streams.read(first)
    streams.read(second)
    streams.price(1, 1, 1.25)
    streams.price(2, 2, 2.3)

    streams.restore()

    expect(start).toHaveBeenCalledTimes(4)
    expect(start.mock.calls.slice(2)).toEqual([
      [3, first],
      [4, second],
    ])
    expect(streams.has(1)).toBe(false)
    expect(streams.has(2)).toBe(false)
    expect(streams.has(3)).toBe(true)
    expect(streams.has(4)).toBe(true)
    expect(streams.read(first)).toEqual({})
    expect(streams.read(second)).toEqual({})
    expect(streams.price(1, 1, 99)).toBe(false)
    streams.price(3, 1, 1.3)
    expect(streams.read(first)).toMatchObject({ bid: 1.3 })
    streams.clear()
  })

  it('retains more than 40 requested streams and cancels only contracts outside the next window', () => {
    const { streams, start, cancel } = fixture()
    const contracts = Array.from({ length: 120 }, (_, index) => ({ conId: index + 1 }))
    streams.readMany(contracts)
    expect(start).toHaveBeenCalledTimes(120)
    expect(cancel).not.toHaveBeenCalled()
    streams.readMany(contracts.slice(1))
    expect(cancel).toHaveBeenCalledExactlyOnceWith(1)
    expect(start).toHaveBeenCalledTimes(120)
    streams.clear()
    expect(cancel).toHaveBeenCalledTimes(120)
    expect(streams.price(2, 1, 99)).toBe(false)
  })
})
