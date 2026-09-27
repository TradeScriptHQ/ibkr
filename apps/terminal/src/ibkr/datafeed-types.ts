export type {
  BarHistoryResult as BackendBarHistoryResult,
  BrokerEvent as BackendEvent,
  MarketDepth as BackendMarketDepth,
  MarketQuote as BackendQuote,
  MarketSessionCalendar as BackendSessionCalendar,
  MarketSessionInfo as BackendSessionInfo,
  MarketSessionWindow as BackendSessionWindow,
  MarketSymbol as BackendMarketSymbol,
  SymbolSearchResult as BackendSymbolSearchResult,
} from '@ibkr-terminal/contracts'

export const TOP_OF_BOOK_DEPTH_MAX_AGE_MS = 10_000
