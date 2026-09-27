import type { SdkSymbolInfo } from '@tradescript/pro/sdk'
import { expect, it, vi } from 'vitest'
import { followInstrument, readInstrument } from './instrument-preference.js'

it('restores the latest selected instrument with its complete identity and unsubscribes', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  let listener: (symbol: SdkSymbolInfo) => void = () => undefined
  const unsubscribe = vi.fn()
  const receive = vi.fn()
  const initial = { ticker: 'AAPL' }
  expect(readInstrument(storage)).toBeUndefined()
  const stop = followInstrument(
    {
      getSymbol: () => initial,
      subscribe: (callback) => {
        listener = callback
        return unsubscribe
      },
    },
    initial,
    storage,
    receive,
  )
  const selected: SdkSymbolInfo = {
    ticker: 'MSFT',
    brokerSymbol: 'MSFT',
    exchange: 'SMART',
    listedExchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock',
    selectionId: 'ibkr:272093',
  }
  listener(selected)
  expect(readInstrument(storage)).toEqual(selected)
  expect(receive).toHaveBeenLastCalledWith(selected)
  stop()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('ignores corrupt preferences and continues selection when storage fails', () => {
  for (const value of ['{', 'null', '{}', '{"ticker":42}', '{"ticker":" "}']) {
    expect(readInstrument({ getItem: () => value, setItem: vi.fn() })).toBeUndefined()
  }
  const storage = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('full')
    },
  }
  expect(readInstrument(storage)).toBeUndefined()
  const receive = vi.fn()
  followInstrument(
    { getSymbol: () => undefined, subscribe: () => () => undefined },
    { ticker: 'NVDA' },
    storage,
    receive,
  )
  expect(receive).toHaveBeenCalledWith({ ticker: 'NVDA' })
})
