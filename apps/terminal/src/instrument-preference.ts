import type { SdkSymbolInfo, TradeScriptAdapterApi } from '@tradescript/pro/sdk'

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>
const STORAGE_KEY = 'ibkr-terminal:last-instrument:v1'

export function readInstrument(storage: PreferenceStorage): SdkSymbolInfo | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    if (
      typeof value === 'object' &&
      value !== null &&
      'ticker' in value &&
      typeof value.ticker === 'string' &&
      value.ticker.trim().length > 0
    ) {
      return { ...value, ticker: value.ticker }
    }
  } catch {
    // Missing or unavailable preferences must not prevent startup.
  }
  return undefined
}

export function followInstrument(
  symbolLink: Pick<TradeScriptAdapterApi['symbolLink'], 'getSymbol' | 'subscribe'>,
  initialSymbol: SdkSymbolInfo,
  storage: PreferenceStorage,
  receive: (symbol: SdkSymbolInfo) => void,
): () => void {
  const publish = (symbol: SdkSymbolInfo) => {
    receive(symbol)
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(symbol))
    } catch {
      // Selection still works when browser storage is unavailable.
    }
  }
  publish(symbolLink.getSymbol() ?? initialSymbol)
  return symbolLink.subscribe(publish)
}
