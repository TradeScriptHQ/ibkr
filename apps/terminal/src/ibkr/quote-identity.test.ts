import type { SymbolInfo } from '@tradescript/pro/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toTradingOrder } from './broker-mapping.js'
import { backendQuoteMatches } from './datafeed-mapping.js'
import { getBackendQuotes, getQuotes } from './datafeed-requests.js'
import type { BackendQuote } from './datafeed-types.js'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter.js'
import { createIbkrMarketDatafeed } from './market-datafeed.js'

afterEach(() => vi.unstubAllGlobals())

const stock: SymbolInfo = {
  ticker: 'LTC',
  brokerSymbol: 'LTC',
  type: 'stock',
  exchange: 'SMART',
  listedExchange: 'NYSE',
  currency: 'USD',
}
const crypto: SymbolInfo = {
  ticker: 'LTC',
  brokerSymbol: 'LTC',
  type: 'crypto',
  exchange: 'PAXOS',
  currency: 'USD',
}
const rawStock: BackendQuote = {
  symbol: {
    symbol: 'LTC',
    assetClass: 'stock',
    exchange: 'SMART',
    primaryExchange: 'NYSE',
    currency: 'USD',
  },
  ask: 60,
  timestamp: '2026-09-30T10:00:00Z',
  status: 'ok',
}
const rawCrypto: BackendQuote = {
  symbol: { symbol: 'LTC', assetClass: 'crypto', exchange: 'PAXOS', currency: 'USD' },
  ask: 70,
  timestamp: '2026-09-30T10:00:00Z',
  status: 'ok',
}

describe('quote instrument identity', () => {
  it('preserves an SDK futures-option readback across its exact native backend quote', async () => {
    const order = toTradingOrder({
      id: 'native-fop',
      accountId: 'paper-options',
      side: 'sell',
      type: 'limit',
      duration: 'day',
      quantity: 2,
      limitPrice: 2.25,
      status: 'working',
      submittedAt: rawStock.timestamp,
      updatedAt: rawStock.timestamp,
      symbol: {
        symbol: 'ES',
        canonicalSymbol: 'IBKR:123',
        assetClass: 'futures-option',
        exchange: 'CME',
        currency: 'USD',
        contractIdentity: { conId: 123, securityType: 'FOP', multiplier: 50 },
      },
    })
    expect(order.symbol).toMatchObject({ type: 'option', brokerSymbol: 'IBKR:123' })
    const quote: BackendQuote = {
      ...rawStock,
      symbol: {
        symbol: 'ES',
        canonicalSymbol: 'IBKR:123',
        assetClass: 'futures-option',
        exchange: 'CME',
        currency: 'USD',
        contractIdentity: { conId: 123, securityType: 'FOP', multiplier: 50 },
      },
      ask: 2.25,
    }
    expect(backendQuoteMatches(quote, order.symbol)).toBe(true)
    expect(
      backendQuoteMatches(
        {
          ...quote,
          symbol: { ...quote.symbol, contractIdentity: { conId: 456, securityType: 'FOP' } },
        },
        order.symbol,
      ),
    ).toBe(false)
    expect(
      backendQuoteMatches(
        {
          ...quote,
          symbol: { ...quote.symbol, contractIdentity: { conId: 123, securityType: 'OPT' } },
        },
        order.symbol,
      ),
    ).toBe(false)
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url))
      if (path.pathname.endsWith('/state'))
        return Response.json({
          connectionStatus: 'connected',
          activeAccountId: 'paper-options',
          accounts: [{ id: 'paper-options', label: 'Synthetic option account', currency: 'USD' }],
          orders: [],
          positions: [],
          executions: [],
          quotes: [],
          messages: [],
          diagnostics: [],
          updatedAt: rawStock.timestamp,
        })
      return path.pathname.endsWith('/sessions')
        ? Response.json({
            symbol: { type: 'futures-option', minTick: 0.25 },
            metadata: { contractMultiplier: 50 },
          })
        : Response.json([quote])
    })
    vi.stubGlobal('fetch', fetch)
    expect(await getQuotes('http://localhost/api', [order.symbol])).toEqual([
      expect.objectContaining({ symbol: order.symbol, ask: 2.25 }),
    ])
    const broker = createIbkrHttpBrokerAdapter({
      baseUrl: 'http://localhost/api',
      executionEnvironment: 'paper',
    })
    expect(
      await broker.getTradingSymbolInfo?.({ symbol: order.symbol, accountId: 'paper-options' }),
    ).toMatchObject({ contractMultiplier: 50, symbol: order.symbol })
    const query = fetch.mock.calls
      .map(([url]) => new URL(String(url)))
      .find((url) => url.pathname.endsWith('/sessions'))?.searchParams
    expect(query?.get('symbol')).toBe('IBKR:123')
    expect(query?.get('assetClass')).toBe('option')
  })
  it('keeps a no-leg option readback on its exact native quote symbol', () => {
    const order = toTradingOrder({
      id: 'restored-option',
      accountId: 'paper-options',
      side: 'sell',
      type: 'limit',
      duration: 'day',
      quantity: 5,
      limitPrice: 2,
      status: 'working',
      submittedAt: '2026-09-30T10:00:00Z',
      updatedAt: '2026-09-30T10:00:00Z',
      symbol: {
        symbol: 'AAPL',
        canonicalSymbol: 'IBKR:123',
        contractIdentity: { securityType: 'OPT', conId: 123 },
        assetClass: 'option',
        exchange: 'SMART',
        currency: 'USD',
      },
    })
    expect(order.optionLegs).toBeUndefined()
    expect(order.symbol).toMatchObject({
      ticker: 'AAPL',
      type: 'option',
      brokerSymbol: 'IBKR:123',
      canonicalSymbol: 'IBKR:123',
    })
  })
  it('groups mixed requests by all metadata instead of dropping each instrument type and venue', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => Response.json([]))
    vi.stubGlobal('fetch', fetchMock)
    await getBackendQuotes('http://localhost/api', [
      stock,
      crypto,
      { ...crypto, ticker: 'BCH', brokerSymbol: 'BCH' },
    ])
    const params = fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams)
    expect(params).toHaveLength(2)
    expect(
      params.find((value) => value.get('assetClass') === 'stock')?.get('primaryExchange'),
    ).toBe('NYSE')
    expect(params.find((value) => value.get('assetClass') === 'crypto')?.getAll('symbol')).toEqual([
      'LTC',
      'BCH',
    ])
    expect(params.find((value) => value.get('assetClass') === 'crypto')?.get('exchange')).toBe(
      'PAXOS',
    )
  })

  it('maps identical tickers to their correct requested type and route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const params = new URL(url).searchParams
        return Response.json(
          params.get('assetClass') === 'stock'
            ? [rawStock]
            : params.get('assetClass') === 'crypto'
              ? [rawCrypto]
              : [rawStock, rawCrypto],
        )
      }),
    )
    const result = await getQuotes('http://localhost/api', [stock, crypto])
    expect(result.find((quote) => quote.ask === 60)?.symbol).toEqual(stock)
    expect(result.find((quote) => quote.ask === 70)?.symbol).toEqual(crypto)
  })

  it('uses exact contract identity for derivative root-symbol readbacks and preserves the listing', () => {
    const outcome: SymbolInfo = {
      ticker: 'FF No 3.625',
      brokerSymbol: 'IBKR:444',
      canonicalSymbol: 'IBKR:444',
      type: 'event-contract',
      exchange: 'FORECASTX',
      currency: 'USD',
    }
    const quote: BackendQuote = {
      ...rawStock,
      symbol: {
        symbol: 'FF',
        canonicalSymbol: 'IBKR:444',
        contractIdentity: { securityType: 'OPT', conId: 444 },
        assetClass: 'event-contract',
        exchange: 'FORECASTX',
        currency: 'USD',
      },
    }
    expect(backendQuoteMatches(quote, outcome)).toBe(true)
    expect(
      backendQuoteMatches(
        {
          ...quote,
          symbol: { ...quote.symbol, contractIdentity: { securityType: 'OPT', conId: 222 } },
        },
        outcome,
      ),
    ).toBe(false)
    expect(
      backendQuoteMatches(
        {
          ...quote,
          symbol: {
            ...quote.symbol,
            canonicalSymbol: 'IBKR:222',
            contractIdentity: { securityType: 'OPT', conId: 222 },
          },
        },
        outcome,
      ),
    ).toBe(false)
    expect(
      backendQuoteMatches(
        { ...rawStock, symbol: { ...rawStock.symbol, primaryExchange: 'LSE' } },
        stock,
      ),
    ).toBe(false)
  })

  it('does not deliver a different venue or type through an identical ticker websocket update', async () => {
    let source: EventTarget | undefined
    class TestEventSource extends EventTarget {
      close = vi.fn()
      constructor() {
        super()
        source = this
      }
    }
    vi.stubGlobal('EventSource', TestEventSource)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([rawCrypto])),
    )
    const feed = createIbkrMarketDatafeed({ baseUrl: 'http://localhost/api' })
    const callback = vi.fn()
    if (!feed.subscribeQuotes) throw new Error('Quote subscription is required')
    const stop = feed.subscribeQuotes({ id: 'crypto-only', symbols: [crypto] }, callback)
    try {
      await vi.waitFor(() => expect(callback).toHaveBeenCalled())
      if (!source) throw new Error('Quote stream is required')
      source.dispatchEvent(
        new MessageEvent('quotes', {
          data: JSON.stringify({ type: 'quotes', quotes: [rawStock] }),
        }),
      )
      expect(callback.mock.lastCall?.[0]?.[0]).toMatchObject({ ask: 70, symbol: crypto })
    } finally {
      stop()
    }
  })
})
