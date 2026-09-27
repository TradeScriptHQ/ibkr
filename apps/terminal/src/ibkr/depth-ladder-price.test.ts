import type { Quote, QuoteCallback, SdkSymbolInfo } from '@tradescript/pro/sdk'
import { describe, expect, it, vi } from 'vitest'
import { depthLadderReferencePrice, followDepthLadderPrice } from './depth-ladder-price.js'

const quote = (values: Partial<Quote>): Quote => ({
  symbol: { ticker: 'AAPL' },
  ...values,
})

describe('depth ladder reference price', () => {
  it('prefers the last trade over the quote midpoint', () => {
    expect(depthLadderReferencePrice(quote({ last: 101.25, bid: 101.2, ask: 101.3 }))).toBe(101.25)
  })

  it('uses the midpoint and then a one-sided quote when no last trade is available', () => {
    expect(depthLadderReferencePrice(quote({ bid: 101.2, ask: 101.3 }))).toBe(101.25)
    expect(depthLadderReferencePrice(quote({ bid: 101.2 }))).toBe(101.2)
    expect(depthLadderReferencePrice(quote({ ask: 101.3 }))).toBe(101.3)
  })

  it('rejects missing and non-positive prices', () => {
    expect(depthLadderReferencePrice(quote({ last: 0, bid: -1, ask: Number.NaN }))).toBeUndefined()
  })
})

it('follows the selected symbol quote stream and ignores the previous symbol after switching', () => {
  const aapl = { ticker: 'AAPL' }
  const msft = { ticker: 'MSFT' }
  const quoteCallbacks: QuoteCallback[] = []
  const unsubscribeQuotes = [vi.fn(), vi.fn()]
  const unsubscribeSymbol = vi.fn()
  let symbolListener: (symbol: SdkSymbolInfo) => void = () => undefined
  const adapter = {
    marketData: {
      getQuotes: vi.fn(async () => []),
      subscribeQuotes: vi.fn((_symbols, callback: QuoteCallback) => {
        quoteCallbacks.push(callback)
        return unsubscribeQuotes[quoteCallbacks.length - 1]
      }),
    },
    symbolLink: {
      getSymbol: () => aapl,
      subscribe: (listener: (symbol: SdkSymbolInfo) => void) => {
        symbolListener = listener
        return unsubscribeSymbol
      },
    },
  } as unknown as Parameters<typeof followDepthLadderPrice>[0]
  const receive = vi.fn()

  const stop = followDepthLadderPrice(adapter, aapl, receive)
  quoteCallbacks[0]?.([quote({ last: 101.25 })])
  expect(receive).toHaveBeenLastCalledWith(101.25)

  symbolListener(msft)
  expect(unsubscribeQuotes[0]).toHaveBeenCalledOnce()
  expect(receive).toHaveBeenLastCalledWith(undefined)
  quoteCallbacks[0]?.([quote({ last: 99 })])
  expect(receive).not.toHaveBeenCalledWith(99)
  quoteCallbacks[1]?.([{ symbol: msft, bid: 200, ask: 202 }])
  expect(receive).toHaveBeenLastCalledWith(201)

  stop()
  expect(unsubscribeSymbol).toHaveBeenCalledOnce()
  expect(unsubscribeQuotes[1]).toHaveBeenCalledOnce()
})
