import type { WatchlistAdapter, WatchlistSymbol, WatchlistSymbolPatch } from '@tradescript/pro'

const STORAGE_KEY = 'ibkr-terminal.watchlist.v1'
const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY']

export function createLocalWatchlistAdapter(): WatchlistAdapter {
  const listeners = new Set<(symbols: WatchlistSymbol[]) => void>()
  let symbols = readSymbols()

  const publish = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols))
    for (const listener of listeners) listener([...symbols])
  }

  return {
    getSymbols: () => [...symbols],
    subscribe(callback) {
      listeners.add(callback)
      callback([...symbols])
      return () => listeners.delete(callback)
    },
    addSymbol(ticker) {
      const normalized = ticker.trim().toUpperCase()
      if (!normalized || symbols.some((item) => item.ticker === normalized)) return false
      symbols = [...symbols, createSymbol(normalized)]
      publish()
      return true
    },
    removeSymbol(ticker) {
      const normalized = ticker.trim().toUpperCase()
      const next = symbols.filter((item) => item.ticker !== normalized)
      if (next.length === symbols.length) return false
      symbols = next
      publish()
      return true
    },
    updateSymbol(ticker: string, patch: WatchlistSymbolPatch) {
      const index = symbols.findIndex((item) => item.ticker === ticker.toUpperCase())
      if (index === -1) return false
      symbols = symbols.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      )
      publish()
      return true
    },
    reorderSymbols(orderedTickers) {
      const byTicker = new Map(symbols.map((item) => [item.ticker, item]))
      const ordered = orderedTickers.flatMap((ticker) => {
        const item = byTicker.get(ticker)
        if (!item) return []
        byTicker.delete(ticker)
        return [item]
      })
      symbols = [...ordered, ...byTicker.values()]
      publish()
      return true
    },
  }
}

function readSymbols(): WatchlistSymbol[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (Array.isArray(parsed)) {
      const symbols = parsed.filter(isWatchlistSymbol)
      if (symbols.length > 0) return symbols
    }
  } catch {
    // A malformed local preference falls back to the workstation defaults.
  }
  return DEFAULT_TICKERS.map(createSymbol)
}

function createSymbol(ticker: string): WatchlistSymbol {
  return {
    ticker,
    id: `ibkr:${ticker}`,
    canonicalSymbol: `ibkr:${ticker}`,
    brokerSymbol: ticker,
    exchange: 'SMART',
    listedExchange: ticker === 'SPY' ? 'ARCA' : 'NASDAQ',
    type: 'stock',
    currency: 'USD',
    provider: 'IBKR',
    dataStatus: 'streaming',
  }
}

function isWatchlistSymbol(value: unknown): value is WatchlistSymbol {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ticker' in value &&
    typeof value.ticker === 'string' &&
    value.ticker.length > 0
  )
}
