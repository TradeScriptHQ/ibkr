import type { SdkMarketDepth, SdkSymbolInfo, TradeScriptAdapterApi } from '@tradescript/pro/sdk'

export function depthStatusMessage(symbol: SdkSymbolInfo, depth?: SdkMarketDepth): string {
  const diagnostic = depth?.diagnostic
  const pending =
    diagnostic?.code == null && diagnostic?.reason?.startsWith('Gateway depth pending:')
  const noResponse =
    diagnostic?.code == null && diagnostic?.reason?.startsWith('Gateway depth no response:')
  if (depth?.metadata?.depthSource === 'top-of-book') {
    const status = depth.metadata.quoteStatus
    const timing = status === 'delayed' ? ' · Delayed quotes' : ''
    const coverage = pending
      ? 'Waiting for Level II'
      : noResponse
        ? 'Level II has not responded'
        : 'Level II unavailable'
    return `Best bid/ask only · ${coverage}${timing}`
  }
  if (pending) return `Waiting for ${symbol.ticker} market depth from IBKR.`
  if (noResponse) return `${symbol.ticker} market depth has not responded. Availability is unknown.`
  if (diagnostic?.reason)
    return `${symbol.ticker} market depth unavailable.\n${diagnostic.provider ?? 'IBKR'}${diagnostic.code == null ? '' : ` ${diagnostic.code}`}: ${diagnostic.reason}`
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
