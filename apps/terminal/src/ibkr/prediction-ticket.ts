import type { BrokerSymbol, SymbolSearchResult } from '@ibkr-terminal/contracts'
import type {
  PredictionMarketOrderTicketOutcome,
  PredictionMarketOrderTicketSymbol,
  SymbolInfo,
} from '@tradescript/pro/sdk'
import { toSymbolInfo } from './datafeed-mapping.js'
import { get, getQuotes } from './datafeed-requests.js'

export async function loadForecastOutcomes(
  selected: SymbolInfo,
): Promise<readonly PredictionMarketOrderTicketOutcome[]> {
  const base = '/api/v1/ibkr'
  const opposite = await get<BrokerSymbol>(
    base,
    `/contracts/opposing-outcome?${new URLSearchParams({ symbol: selected.brokerSymbol ?? selected.ticker, currency: selected.currency ?? '' })}`,
  )
  if (!opposite.contractIdentity?.conId) throw new Error('IBKR omitted the opposing outcome ID.')
  const ids = [selected.brokerSymbol ?? selected.ticker, `IBKR:${opposite.contractIdentity?.conId}`]
  const symbols = await Promise.all(
    ids.map(async (id): Promise<PredictionMarketOrderTicketSymbol> => {
      const rows = await get<SymbolSearchResult[]>(
        base,
        `/symbols/search?${new URLSearchParams({ query: id, assetClass: 'event-contract', exchange: 'FORECASTX' })}`,
      )
      const row = rows.find((row) => row.symbol.canonicalSymbol === id)?.symbol
      if (!row?.prediction || row.type !== 'event-contract' || !row.currency)
        throw new Error('Forecast outcome metadata is incomplete.')
      return {
        ...toSymbolInfo(row),
        provider: 'ibkr',
        canonicalSymbol: id,
        brokerSymbol: id,
        selectionId: id,
        marketDataSeriesId: id,
        type: 'event-contract',
        instrument: row.prediction,
      }
    }),
  )
  const quotes = await getQuotes(base, symbols)
  return symbols.map((symbol) => {
    const quote = quotes.find((quote) => quote.symbol.canonicalSymbol === symbol.canonicalSymbol)
    return {
      symbol,
      tone: symbol.instrument.outcomeLabel === 'Yes' ? 'positive' : 'negative',
      ...(quote ? { quote: { ...quote, symbol } } : {}),
    }
  })
}
