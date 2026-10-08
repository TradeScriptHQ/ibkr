import type { BackendMarketSymbol } from './datafeed-types.js'

// Bare Logo.dev tickers resolve against US exchanges. Other listings use the
// ISIN supplied by IBKR, so a shared ticker never selects a different issuer.
const US_STOCK_EXCHANGES = new Set([
  'NASDAQ',
  'NYSE',
  'ARCA',
  'AMEX',
  'BATS',
  'IEX',
  'OTCBB',
  'PINK',
])

export function logoDevPublishableKey(value: string | undefined): string {
  const key = value?.trim() ?? ''
  if (key && !/^pk_[A-Za-z0-9_-]+$/u.test(key)) {
    throw new Error('VITE_LOGO_DEV_PUBLISHABLE_KEY must be a Logo.dev publishable (pk_) key.')
  }
  return key
}

/** Stable image URLs let the desktop WebView reuse Logo.dev's 24-hour HTTP cache. */
export function symbolLogoUrl(
  symbol: Pick<BackendMarketSymbol, 'ticker' | 'type' | 'primaryExchange' | 'isin'>,
  publishableKey = import.meta.env?.VITE_LOGO_DEV_PUBLISHABLE_KEY,
): string | undefined {
  const key = logoDevPublishableKey(publishableKey)
  const ticker = symbol.ticker.trim().toUpperCase()
  if (!key || !ticker) return undefined

  let path: string
  if (symbol.type === 'crypto') {
    path = `crypto/${encodeURIComponent(ticker)}`
  } else if (symbol.type === 'stock') {
    const isin = symbol.isin?.trim().toUpperCase()
    if (isin && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/u.test(isin)) {
      path = `isin/${isin}`
    } else if (US_STOCK_EXCHANGES.has(symbol.primaryExchange?.toUpperCase() ?? '')) {
      path = `ticker/${encodeURIComponent(ticker)}`
    } else {
      return undefined
    }
  } else {
    return undefined
  }

  const url = new URL(`https://img.logo.dev/${path}`)
  url.search = new URLSearchParams({
    token: key,
    size: '64',
    format: 'png',
    theme: 'dark',
    retina: 'true',
    fallback: '404',
  }).toString()
  return url.href
}
