import type { WatchlistAdapter, WatchlistSymbol, WatchlistSymbolPatch } from '@tradescript/pro'
import type { MarketDataFeed, SdkSymbolInfo } from '@tradescript/pro/sdk'

const STORAGE_KEY = 'ibkr-terminal.watchlist.v2'
const LEGACY_STORAGE_KEY = 'ibkr-terminal.watchlist.v1'
const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY']
const STORED_INSTRUMENT_TYPES = [
  'stock',
  'index',
  'forex',
  'crypto',
  'futures',
  'continuous-futures',
  'option',
  'futures-option',
  'fund',
  'bond',
  'cfd',
  'warrant',
  'commodity',
  'prediction-market',
  'prediction-contract',
  'event-contract',
] as const satisfies readonly NonNullable<SdkSymbolInfo['type']>[]

export async function createLocalWatchlistAdapter(
  datafeed: Pick<MarketDataFeed, 'searchSymbols' | 'resolveSymbol'>,
  getSelectedSymbol: () => SdkSymbolInfo | undefined,
) {
  const listeners = new Set<(symbols: WatchlistSymbol[]) => void>()
  const resolve = async (
    ticker: string,
    persisted?: SdkSymbolInfo,
  ): Promise<WatchlistSymbol | undefined> => {
    const selected = getSelectedSymbol()
    let symbol = persisted ?? (selected?.ticker.toUpperCase() === ticker ? selected : undefined)
    if (!symbol) {
      if (!datafeed.searchSymbols) return undefined
      const matches = (await datafeed.searchSymbols({ searchText: ticker, limit: 40 })).filter(
        (match) => match.symbol.ticker.toUpperCase() === ticker,
      )
      const unique = new Map(matches.map(({ symbol }) => [symbolIdentity(symbol), symbol]))
      if (unique.size !== 1) return undefined
      symbol = [...unique.values()][0]
    }
    if (!symbol || !datafeed.resolveSymbol) return undefined
    const qualified = await datafeed.resolveSymbol(symbol)
    if (!qualified.type || !qualified.exchange || !qualified.currency || !qualified.brokerSymbol)
      return undefined
    const { group: _searchGrouping, ...fields } = qualified
    return { ...fields, id: symbolIdentity(qualified) }
  }
  const saved = readSymbols()
  let symbols = (
    await Promise.all(
      saved.items.map(async (item) => {
        try {
          const qualified = await resolve(
            item.ticker.trim().toUpperCase(),
            saved.qualified ? persistedSymbol(item) : undefined,
          )
          return qualified ? { ...qualified, ...presentation(item) } : undefined
        } catch {
          return undefined
        }
      }),
    )
  ).filter((item): item is WatchlistSymbol => item !== undefined)

  const publish = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols))
    for (const listener of listeners) listener([...symbols])
  }

  return {
    getSymbols: () => [...symbols],
    subscribe(callback: (symbols: WatchlistSymbol[]) => void) {
      listeners.add(callback)
      callback([...symbols])
      return () => listeners.delete(callback)
    },
    async addSymbol(ticker: string, selectedSymbol?: SdkSymbolInfo) {
      const normalized = ticker.trim().toUpperCase()
      if (!normalized || symbols.some((item) => item.ticker === normalized)) return false
      if (selectedSymbol && selectedSymbol.ticker.trim().toUpperCase() !== normalized) return false
      const qualified = await resolve(normalized, selectedSymbol)
      if (
        !qualified ||
        symbols.some(
          (item) =>
            item.ticker === normalized || symbolIdentity(item) === symbolIdentity(qualified),
        )
      )
        return false
      symbols = [...symbols, qualified]
      publish()
      return true
    },
    removeSymbol(ticker: string) {
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
    reorderSymbols(orderedTickers: string[]) {
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
  } satisfies WatchlistAdapter
}

function readSymbols(): { items: WatchlistSymbol[]; qualified: boolean } {
  try {
    const current = localStorage.getItem(STORAGE_KEY)
    const parsed = JSON.parse(
      current ?? localStorage.getItem(LEGACY_STORAGE_KEY) ?? '[]',
    ) as unknown
    if (Array.isArray(parsed)) {
      const symbols = parsed.filter(isWatchlistSymbol)
      if (symbols.length > 0 || current !== null)
        return { items: symbols, qualified: current !== null }
    }
  } catch {
    // A malformed local preference falls back to the workstation defaults.
  }
  return { items: DEFAULT_TICKERS.map((ticker) => ({ ticker })), qualified: false }
}

function symbolIdentity(
  symbol: Pick<
    WatchlistSymbol,
    | 'ticker'
    | 'canonicalSymbol'
    | 'brokerSymbol'
    | 'type'
    | 'exchange'
    | 'listedExchange'
    | 'currency'
  >,
): string {
  return [
    symbol.canonicalSymbol ?? symbol.brokerSymbol ?? symbol.ticker,
    symbol.type,
    symbol.exchange,
    symbol.listedExchange,
    symbol.currency,
  ].join('|')
}

function persistedSymbol(symbol: WatchlistSymbol): SdkSymbolInfo | undefined {
  const type = symbol.type
  if (!isInstrumentType(type) || !symbol.brokerSymbol || !symbol.exchange || !symbol.currency)
    return undefined
  return {
    ticker: symbol.ticker,
    type,
    brokerSymbol: symbol.brokerSymbol,
    exchange: symbol.exchange,
    currency: symbol.currency,
    ...(symbol.canonicalSymbol ? { canonicalSymbol: symbol.canonicalSymbol } : {}),
    ...(symbol.listedExchange ? { listedExchange: symbol.listedExchange } : {}),
    ...(symbol.provider ? { provider: symbol.provider } : {}),
    ...(symbol.marketType ? { marketType: symbol.marketType } : {}),
    ...(symbol.sessionCloseAuthorityId
      ? { sessionCloseAuthorityId: symbol.sessionCloseAuthorityId }
      : {}),
    ...(symbol.sessionCloseEventIdPrefix
      ? { sessionCloseEventIdPrefix: symbol.sessionCloseEventIdPrefix }
      : {}),
  }
}

function isInstrumentType(value: string | undefined): value is NonNullable<SdkSymbolInfo['type']> {
  return value !== undefined && new Set<string>(STORED_INSTRUMENT_TYPES).has(value)
}

function presentation(symbol: WatchlistSymbol): WatchlistSymbolPatch {
  return {
    ...(symbol.colorTag === undefined ? {} : { colorTag: symbol.colorTag }),
    ...(symbol.notes === undefined ? {} : { notes: symbol.notes }),
    ...(symbol.sortOrder === undefined ? {} : { sortOrder: symbol.sortOrder }),
    ...(symbol.group === undefined ? {} : { group: symbol.group }),
    ...(symbol.logoUrl === undefined ? {} : { logoUrl: symbol.logoUrl }),
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
