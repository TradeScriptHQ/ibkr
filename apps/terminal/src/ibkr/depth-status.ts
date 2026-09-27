import type { SdkMarketDepth, SdkSymbolInfo, TradeScriptAdapterApi } from '@tradescript/pro/sdk'

export function depthStatusMessage(symbol: SdkSymbolInfo, depth?: SdkMarketDepth): string {
  if (depth?.metadata?.depthSource === 'top-of-book') {
    const status = depth.metadata.quoteStatus
    const timing = status === 'delayed' ? ' · Delayed quotes' : ''
    return `Best bid/ask only · Level II unavailable${timing}`
  }
  const diagnostic = depth?.metadata?.depthDiagnostic as
    | { message?: string | undefined; code?: number | undefined }
    | undefined
  if (diagnostic?.message) {
    return `${symbol.ticker} market depth unavailable.\nIBKR${diagnostic.code == null ? '' : ` ${diagnostic.code}`}: ${diagnostic.message}`
  }
  return `Waiting for ${symbol.ticker} market depth from IBKR.`
}

/** Supply the SDK's public empty-state label from the broker's actual response. */
export function followDepthStatus(
  adapter: Pick<TradeScriptAdapterApi, 'marketData' | 'symbolLink'>,
  initialSymbol: SdkSymbolInfo,
  receive: (message: string) => void,
): () => void {
  let generation = 0
  let unsubscribeDepth: (() => void) | undefined
  let previous: string | undefined
  const publish = (message: string) => {
    if (message === previous) return
    previous = message
    receive(message)
  }
  const follow = (symbol: SdkSymbolInfo) => {
    const current = ++generation
    unsubscribeDepth?.()
    publish(depthStatusMessage(symbol))
    unsubscribeDepth = adapter.marketData.subscribeDepth({ symbol, levels: 20 }, (depth) => {
      if (current !== generation) return
      publish(depthStatusMessage(symbol, depth))
    })
  }
  follow(adapter.symbolLink.getSymbol() ?? initialSymbol)
  const unsubscribeSymbol = adapter.symbolLink.subscribe(follow)
  return () => {
    generation++
    unsubscribeSymbol()
    unsubscribeDepth?.()
  }
}
