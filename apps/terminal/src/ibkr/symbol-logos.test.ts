import { afterEach, expect, it, vi } from 'vitest'
import { toSymbolInfo } from './datafeed-mapping.js'
import { logoDevPublishableKey, symbolLogoUrl } from './symbol-logos.js'
import { IBKR_DEFAULT_SYMBOLS } from './symbol-search-presets.js'

const key = 'pk_test_logo_key'
const apple = {
  ticker: 'AAPL',
  canonicalSymbol: 'IBKR:265598',
  exchange: 'SMART',
  primaryExchange: 'NASDAQ',
  type: 'stock' as const,
  currency: 'USD',
}

afterEach(() => vi.unstubAllEnvs())

it('keeps initials when no key is configured and rejects secret keys without exposing them', () => {
  expect(logoDevPublishableKey(undefined)).toBe('')
  expect(symbolLogoUrl(apple, '')).toBeUndefined()
  expect(() => logoDevPublishableKey('sk_test_secret')).toThrow(
    'VITE_LOGO_DEV_PUBLISHABLE_KEY must be a Logo.dev publishable (pk_) key.',
  )
})

it('uses one stable URL for US ticker images with dark, retina and local fallback options', () => {
  const url = new URL(symbolLogoUrl(apple, key) ?? '')
  expect(url.origin).toBe('https://img.logo.dev')
  expect(url.pathname).toBe('/ticker/AAPL')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    token: key,
    size: '64',
    format: 'png',
    theme: 'dark',
    retina: 'true',
    fallback: '404',
  })
  expect(symbolLogoUrl(apple, ` ${key} `)).toBe(url.href)
})

it('uses IBKR ISINs to distinguish issuers sharing a ticker and share images across listings', () => {
  const us = { ...apple, isin: 'US0378331005' }
  const mexico = { ...us, primaryExchange: 'MEXI', currency: 'MXN' }
  const differentIssuer = { ...mexico, isin: 'CA03785Y1007' }
  expect(new URL(symbolLogoUrl(us, key) ?? '').pathname).toBe('/isin/US0378331005')
  expect(symbolLogoUrl(mexico, key)).toBe(symbolLogoUrl(us, key))
  expect(symbolLogoUrl(differentIssuer, key)).not.toBe(symbolLogoUrl(us, key))
})

it.each(['IBIS', 'LSE', 'TSE', 'SMART', undefined])(
  'keeps initials for an unqualified %s listing instead of guessing a US ticker',
  (primaryExchange) => {
    expect(symbolLogoUrl({ ...apple, primaryExchange }, key)).toBeUndefined()
  },
)

it('uses the crypto endpoint and safely encodes identifiers in the URL path', () => {
  expect(new URL(symbolLogoUrl({ ticker: 'btc', type: 'crypto' }, key) ?? '').pathname).toBe(
    '/crypto/BTC',
  )
  const url = new URL(symbolLogoUrl({ ...apple, ticker: 'ABC/DEF?x=1' }, key) ?? '')
  expect(url.pathname).toBe('/ticker/ABC%2FDEF%3FX%3D1')
  expect(url.searchParams.has('x')).toBe(false)
})

it.each(['forex', 'futures', 'option', 'index', 'fund', 'bond', undefined] as const)(
  'keeps the existing initials for %s instruments',
  (type) => {
    expect(symbolLogoUrl({ ...apple, type }, key)).toBeUndefined()
  },
)

it('supplies logos through the normal symbol mapper without changing contract identity', () => {
  vi.stubEnv('VITE_LOGO_DEV_PUBLISHABLE_KEY', key)
  const mapped = toSymbolInfo(apple)
  expect(mapped).toMatchObject({
    ticker: apple.ticker,
    canonicalSymbol: apple.canonicalSymbol,
    brokerSymbol: apple.ticker,
    exchange: apple.exchange,
    listedExchange: apple.primaryExchange,
    type: apple.type,
    currency: apple.currency,
    logoUrl: symbolLogoUrl(apple, key),
  })
  vi.stubEnv('VITE_LOGO_DEV_PUBLISHABLE_KEY', '')
  expect(toSymbolInfo(apple)).not.toHaveProperty('logoUrl')
})

it('makes each eligible default picker contract use the same URL as a mapped search result', async () => {
  vi.stubEnv('VITE_LOGO_DEV_PUBLISHABLE_KEY', key)
  vi.resetModules()
  const { IBKR_DEFAULT_SYMBOLS: configured } = await import('./symbol-search-presets.js')
  expect(configured.find((symbol) => symbol.ticker === 'AAPL')?.logoUrl).toBe(
    symbolLogoUrl(apple, key),
  )
  expect(configured.find((symbol) => symbol.ticker === 'BTC')?.logoUrl).toContain('/crypto/BTC?')
  expect(configured.find((symbol) => symbol.ticker === 'EURUSD')).not.toHaveProperty('logoUrl')
  expect(configured.map((symbol) => symbol.canonicalSymbol)).toEqual(
    IBKR_DEFAULT_SYMBOLS.map((symbol) => symbol.canonicalSymbol),
  )
})
