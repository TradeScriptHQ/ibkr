import type { SymbolInfo, SymbolSearchSavedView } from '@tradescript/pro/sdk'
import { toSymbolInfo } from './datafeed-mapping.js'
import type { BackendMarketSymbol } from './datafeed-types.js'

/**
 * Listed in the symbol picker before the user types. These are the gateway's
 * own search rows for each contract (pinned by IBKR conId; forex pairs are
 * IDEALPRO), mapped exactly as search results are, so choosing one resolves
 * that contract rather than searching again.
 */
const DEFAULT_CONTRACTS: BackendMarketSymbol[] = [
  stock(756733, 'SPY', 'ARCA', 'SS SPDR S&P 500 ETF TRUST-US'),
  stock(320227571, 'QQQ', 'NASDAQ', 'INVESCO QQQ TRUST SERIES 1'),
  stock(265598, 'AAPL', 'NASDAQ', 'APPLE INC'),
  stock(4815747, 'NVDA', 'NASDAQ', 'NVIDIA CORP'),
  stock(272093, 'MSFT', 'NASDAQ', 'MICROSOFT CORP'),
  stock(3691937, 'AMZN', 'NASDAQ', 'AMAZON.COM INC'),
  stock(107113386, 'META', 'NASDAQ', 'META PLATFORMS INC-CLASS A'),
  stock(76792991, 'TSLA', 'NASDAQ', 'TESLA INC'),
  stock(208813719, 'GOOGL', 'NASDAQ', 'ALPHABET INC-CL A'),
  forex('EUR', 'USD'),
  forex('USD', 'JPY'),
  forex('GBP', 'USD'),
  crypto(479624278, 'BTC', 'Bitcoin cryptocurrency'),
  crypto(495759171, 'ETH', 'Ethereum cryptocurrency'),
]

function stock(
  conId: number,
  ticker: string,
  primaryExchange: string,
  name: string,
): BackendMarketSymbol {
  return {
    ticker,
    canonicalSymbol: `IBKR:${conId}`,
    exchange: 'SMART',
    primaryExchange,
    name,
    description: name,
    type: 'stock',
    currency: 'USD',
  }
}

function forex(base: string, quote: string): BackendMarketSymbol {
  return {
    ticker: `${base}${quote}`,
    exchange: 'IDEALPRO',
    name: `${base}/${quote}`,
    description: `${base}/${quote} · IDEALPRO Forex`,
    type: 'forex',
    currency: quote,
  }
}

function crypto(conId: number, ticker: string, name: string): BackendMarketSymbol {
  return {
    ticker,
    canonicalSymbol: `IBKR:${conId}`,
    exchange: 'PAXOS',
    name,
    description: name,
    type: 'crypto',
    currency: 'USD',
  }
}

export const IBKR_DEFAULT_SYMBOLS: SymbolInfo[] = DEFAULT_CONTRACTS.map(toSymbolInfo)

/** One-click filter presets; every value is a filter the IBKR feed declares. */
export const IBKR_SAVED_VIEWS: SymbolSearchSavedView[] = [
  { id: 'cme-futures', label: 'CME futures', assetType: 'futures', exchange: 'CME' },
  { id: 'usd-stocks', label: 'USD stocks', assetType: 'stock', quoteCurrency: 'USD' },
  {
    id: 'forecast-contracts',
    label: 'Forecast contracts',
    assetType: 'event-contract',
    exchange: 'FORECASTX',
  },
]
