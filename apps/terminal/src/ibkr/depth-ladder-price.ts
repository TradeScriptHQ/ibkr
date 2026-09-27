import type { Quote, SdkSymbolInfo, TradeScriptAdapterApi } from '@tradescript/pro/sdk'

function positivePrice(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

/** Keep the ladder's price spine independent from Level II availability. */
export function depthLadderReferencePrice(quote: Quote): number | undefined {
  if (positivePrice(quote.last)) return quote.last
  if (positivePrice(quote.bid) && positivePrice(quote.ask)) {
    return (quote.bid + quote.ask) / 2
  }
  if (positivePrice(quote.bid)) return quote.bid
  if (positivePrice(quote.ask)) return quote.ask
  return undefined
}

export function followDepthLadderPrice(
  adapter: Pick<TradeScriptAdapterApi, 'marketData' | 'symbolLink'>,
  initialSymbol: SdkSymbolInfo,
  receive: (price: number | undefined) => void,
): () => void {
  let generation = 0
  let unsubscribeQuotes: (() => void) | undefined
  let previous: number | undefined

  const publish = (price: number | undefined) => {
    if (Object.is(price, previous)) return
    previous = price
    receive(price)
  }
  const follow = (symbol: SdkSymbolInfo) => {
    const current = ++generation
    unsubscribeQuotes?.()
    publish(undefined)

    const accept = (quotes: Quote[]) => {
      if (current !== generation) return
      const quote = quotes.find(
        (candidate) => candidate.symbol.ticker.toUpperCase() === symbol.ticker.toUpperCase(),
      )
      if (!quote) return
      const price = depthLadderReferencePrice(quote)
      if (price !== undefined) publish(price)
    }

    void adapter.marketData
      .getQuotes({ symbols: [symbol] })
      .then(accept)
      .catch(() => undefined)
    unsubscribeQuotes = adapter.marketData.subscribeQuotes([symbol], accept, {
      fastSymbols: [symbol],
    })
  }

  follow(adapter.symbolLink.getSymbol() ?? initialSymbol)
  const unsubscribeSymbol = adapter.symbolLink.subscribe(follow)
  return () => {
    generation++
    unsubscribeSymbol()
    unsubscribeQuotes?.()
  }
}
