import type { SdkSymbolInfo } from '@tradescript/pro/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalWatchlistAdapter } from './watchlist.js'

afterEach(() => vi.unstubAllGlobals())
const listing: SdkSymbolInfo = {
  ticker: 'ASML',
  canonicalSymbol: 'IBKR:123',
  brokerSymbol: 'IBKR:123',
  type: 'stock',
  exchange: 'AEB',
  listedExchange: 'AEB',
  currency: 'EUR',
}
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  return values
}
function feed(matches: SdkSymbolInfo[] = [listing]) {
  return {
    searchSymbols: vi.fn(async (request: { searchText: string }) =>
      matches
        .filter((symbol) => symbol.ticker === request.searchText)
        .map((symbol) => ({ symbol })),
    ),
    resolveSymbol: vi.fn(async (symbol: string | SdkSymbolInfo) => {
      if (typeof symbol === 'string') throw new Error('Qualified identity required')
      return symbol
    }),
  }
}
it('stores the selected broker listing without inventing a US stock or streaming status', async () => {
  const values = storage({ 'ibkr-terminal.watchlist.v2': '[]' })
  const datafeed = feed([
    listing,
    {
      ...listing,
      brokerSymbol: 'IBKR:456',
      canonicalSymbol: 'IBKR:456',
      exchange: 'NASDAQ',
      currency: 'USD',
    },
  ])
  const adapter = await createLocalWatchlistAdapter(datafeed, () => listing)
  expect(await adapter.addSymbol?.('ASML')).toBe(true)
  expect(await adapter.getSymbols()).toEqual([expect.objectContaining(listing)])
  expect((await adapter.getSymbols())[0]?.dataStatus).toBeUndefined()
  expect(datafeed.searchSymbols).not.toHaveBeenCalled()
  expect(values.get('ibkr-terminal.watchlist.v2')).toContain('AEB')
})
it('rejects ambiguous same-ticker listings without choosing the first broker match', async () => {
  storage({ 'ibkr-terminal.watchlist.v2': '[]' })
  const datafeed = feed([
    listing,
    { ...listing, canonicalSymbol: 'IBKR:456', brokerSymbol: 'IBKR:456', currency: 'USD' },
  ])
  const adapter = await createLocalWatchlistAdapter(datafeed, () => undefined)
  expect(await adapter.addSymbol?.('ASML')).toBe(false)
  expect(await adapter.getSymbols()).toEqual([])
  expect(datafeed.resolveSymbol).not.toHaveBeenCalled()
})
it('requalifies legacy rows using broker search instead of their fabricated NASDAQ identity', async () => {
  storage({
    'ibkr-terminal.watchlist.v1': JSON.stringify([
      {
        ticker: 'ASML',
        type: 'stock',
        exchange: 'SMART',
        listedExchange: 'NASDAQ',
        currency: 'USD',
        notes: 'keep this note',
      },
    ]),
  })
  const datafeed = feed()
  const adapter = await createLocalWatchlistAdapter(datafeed, () => undefined)
  expect(await adapter.getSymbols()).toEqual([
    expect.objectContaining({ ...listing, notes: 'keep this note' }),
  ])
  expect(datafeed.resolveSymbol).toHaveBeenCalledWith(listing)
})
it('restores qualified listings without repeating ambiguous ticker search', async () => {
  storage({ 'ibkr-terminal.watchlist.v2': JSON.stringify([listing]) })
  const datafeed = feed([])
  const adapter = await createLocalWatchlistAdapter(datafeed, () => undefined)
  expect(await adapter.getSymbols()).toEqual([expect.objectContaining(listing)])
  expect(datafeed.searchSymbols).not.toHaveBeenCalled()
})
it('keeps concurrent additions unique after asynchronous qualification', async () => {
  storage({ 'ibkr-terminal.watchlist.v2': '[]' })
  const adapter = await createLocalWatchlistAdapter(feed(), () => undefined)
  const results = await Promise.all([adapter.addSymbol?.('ASML'), adapter.addSymbol?.('ASML')])
  expect(results.sort()).toEqual([false, true])
  expect(await adapter.getSymbols()).toHaveLength(1)
})

it('adds the exact search selection while the chart shows a different ticker', async () => {
  storage({ 'ibkr-terminal.watchlist.v2': '[]' })
  const apple: SdkSymbolInfo = { ...listing, ticker: 'AAPL' }
  const otherApple: SdkSymbolInfo = {
    ...apple,
    canonicalSymbol: 'IBKR:456',
    brokerSymbol: 'IBKR:456',
    currency: 'USD',
  }
  const datafeed = feed([apple, otherApple])
  const adapter = await createLocalWatchlistAdapter(datafeed, () => listing)
  expect(await adapter.addSymbol?.('AAPL', otherApple)).toBe(true)
  expect(await adapter.getSymbols()).toEqual([expect.objectContaining(otherApple)])
  expect(datafeed.resolveSymbol).toHaveBeenCalledWith(otherApple)
  expect(datafeed.searchSymbols).not.toHaveBeenCalled()
})

it('uses the selected listing instead of the chart listing with the same ticker', async () => {
  storage({ 'ibkr-terminal.watchlist.v2': '[]' })
  const selected: SdkSymbolInfo = {
    ...listing,
    canonicalSymbol: 'IBKR:456',
    brokerSymbol: 'IBKR:456',
    currency: 'USD',
  }
  const datafeed = feed([listing, selected])
  const adapter = await createLocalWatchlistAdapter(datafeed, () => listing)
  expect(await adapter.addSymbol?.('ASML', selected)).toBe(true)
  expect(await adapter.getSymbols()).toEqual([expect.objectContaining(selected)])
  expect(datafeed.resolveSymbol).toHaveBeenCalledWith(selected)
})

it('rejects mismatched selection context without searching or qualifying another symbol', async () => {
  storage({ 'ibkr-terminal.watchlist.v2': '[]' })
  const datafeed = feed([{ ...listing, ticker: 'AAPL' }])
  const adapter = await createLocalWatchlistAdapter(datafeed, () => undefined)
  expect(await adapter.addSymbol?.('AAPL', listing)).toBe(false)
  expect(await adapter.getSymbols()).toEqual([])
  expect(datafeed.searchSymbols).not.toHaveBeenCalled()
  expect(datafeed.resolveSymbol).not.toHaveBeenCalled()
})
