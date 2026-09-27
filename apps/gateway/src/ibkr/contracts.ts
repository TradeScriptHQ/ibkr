import type { Contract, ContractDescription, ContractDetails } from '@stoqey/ib'
import { OptionType, SecType } from '@stoqey/ib'
import { RequestError } from './request-error.js'
import type {
  BrokerSymbol,
  MarketSymbol,
  OptionContract,
  OptionOrderLegDraft,
  OrderDuration,
  SourceSymbolIdentity,
} from './types.js'

const CRYPTO_EXCHANGES = new Set(['PAXOS', 'ZEROHASH'])

const FOREX_EXCHANGE = 'IDEALPRO'

// IBKR's spot-currency catalogue; KRW/MYR/TWD require special conversion functionality.
// Recognition is not contract qualification: execution still resolves the pair with TWS.
const FOREX_CODES = new Set([
  'USD',
  'AED',
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNH',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'ILS',
  'JPY',
  'MXN',
  'NOK',
  'NZD',
  'PLN',
  'RON',
  'SAR',
  'SEK',
  'SGD',
  'TRY',
  'ZAR',
])

const MAJOR_FOREX_PAIRS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'USDCAD',
  'NZDUSD',
  'EURGBP',
  'EURJPY',
  'GBPJPY',
  'EURCHF',
  'AUDJPY',
  'CADJPY',
  'CHFJPY',
]

type SupportedAssetClass =
  | 'stock'
  | 'crypto'
  | 'forex'
  | 'futures'
  | 'index'
  | 'fund'
  | 'bond'
  | 'cfd'
  | 'warrant'
  | 'commodity'
  | 'event-contract'

export function normalizeTicker(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.:-]/g, '')
}

export function brokerContractSourceRouteKey(contract: Contract): string {
  return [
    String(contract.secType ?? ''),
    String(contract.symbol ?? '').toUpperCase(),
    String(contract.currency ?? '').toUpperCase(),
  ].join('|')
}

export function sourceSymbolIdentityKey(symbol: SourceSymbolIdentity): string {
  return JSON.stringify([
    symbol.canonicalSymbol,
    symbol.ticker,
    symbol.brokerSymbol,
    symbol.provider,
    symbol.selectionId,
    symbol.marketDataSeriesId,
    symbol.exchange,
    symbol.listedExchange,
    symbol.currency,
    symbol.type,
    symbol.marketType,
    symbol.resolveRevision,
  ])
}

export function withBrokerSourceSymbol(symbol: BrokerSymbol): BrokerSymbol {
  return {
    ...symbol,
    sourceSymbol: symbol.sourceSymbol ?? {
      ticker: symbol.symbol,
      canonicalSymbol: symbol.canonicalSymbol,
      brokerSymbol: [
        'futures',
        'index',
        'fund',
        'event-contract',
        'bond',
        'warrant',
        'commodity',
        'cfd',
      ].includes(symbol.assetClass ?? '')
        ? symbol.canonicalSymbol
        : symbol.symbol,
      exchange: symbol.exchange,
      listedExchange: symbol.primaryExchange,
      currency: symbol.currency,
      type: symbol.assetClass,
    },
  }
}

export function resolveAssetClass(
  assetClass?: string,
  exchange?: string,
): SupportedAssetClass | undefined {
  const normalized = assetClass?.trim().toLowerCase()
  if (
    normalized === 'futures' ||
    normalized === 'index' ||
    normalized === 'fund' ||
    normalized === 'bond' ||
    normalized === 'cfd' ||
    normalized === 'warrant' ||
    normalized === 'commodity' ||
    normalized === 'event-contract'
  )
    return normalized
  if (normalized === 'stock' || normalized === 'equity') return 'stock'
  if (normalized === 'crypto' || normalized === 'spot' || normalized === 'crypto_spot')
    return 'crypto'
  if (normalized === 'forex' || normalized === 'fx' || normalized === 'cash') return 'forex'
  // An explicit security type must not be replaced by an inference from its venue.
  if (normalized) return undefined
  if (exchange && CRYPTO_EXCHANGES.has(exchange.toUpperCase())) return 'crypto'
  if (exchange?.trim().toUpperCase() === FOREX_EXCHANGE) return 'forex'
  if (!normalized) return 'stock'
  return undefined
}

export function inferAssetClass(symbol: BrokerSymbol): SupportedAssetClass {
  if (parseForexSymbol(symbol.symbol, symbol.currency)) return 'forex'
  const ticker = symbol.symbol.trim().toUpperCase()
  if (ticker === 'BTC' || ticker === 'ETH') return 'crypto'
  return 'stock'
}

function toSupportedAssetClass(secType?: SecType | string): SupportedAssetClass | undefined {
  if (secType === SecType.BOND) return 'bond'
  if (secType === SecType.WAR) return 'warrant'
  if (secType === SecType.CMDTY) return 'commodity'
  if (secType === SecType.CFD) return 'cfd'
  if (secType === SecType.FUT) return 'futures'
  if (secType === SecType.IND) return 'index'
  if (secType === SecType.FUND) return 'fund'
  if (secType === SecType.STK || secType === 'STK') return 'stock'
  if (secType === SecType.CRYPTO || secType === 'CRYPTO') return 'crypto'
  if (secType === SecType.CASH || secType === 'CASH') return 'forex'
  return undefined
}

function normalizeCryptoExchange(exchange?: string): string {
  const normalized = exchange?.trim().toUpperCase()
  return normalized && CRYPTO_EXCHANGES.has(normalized) ? normalized : 'PAXOS'
}

export function toIbContract(
  symbol: BrokerSymbol,
  duration?: OrderDuration,
  routingDestination?: string,
): Contract {
  const assetClass =
    symbol.assetClass || symbol.exchange
      ? resolveAssetClass(symbol.assetClass, symbol.exchange)
      : inferAssetClass(symbol)
  if (!assetClass) {
    throw new RequestError(400, `Unsupported instrument type ${symbol.assetClass}`)
  }
  if (assetClass !== 'stock' && assetClass !== 'crypto' && assetClass !== 'forex') {
    const conId = nativeContractId(symbol.symbol) ?? symbol.contractIdentity?.conId
    if (
      !conId ||
      !Number.isSafeInteger(conId) ||
      conId <= 0 ||
      !symbol.exchange ||
      !symbol.currency
    ) {
      throw new RequestError(
        400,
        'Select an exact IBKR contract with its exchange and currency before requesting this instrument.',
      )
    }
    return {
      conId,
      secType: {
        futures: SecType.FUT,
        index: SecType.IND,
        fund: SecType.FUND,
        bond: SecType.BOND,
        cfd: SecType.CFD,
        warrant: SecType.WAR,
        commodity: SecType.CMDTY,
        'event-contract': SecType.OPT,
      }[assetClass],
      exchange: routingDestination ?? symbol.exchange,
      currency: symbol.currency,
    }
  }
  if (assetClass === 'crypto') {
    return {
      symbol: symbol.symbol.toUpperCase(),
      secType: SecType.CRYPTO,
      exchange: normalizeCryptoExchange(routingDestination ?? symbol.exchange),
      currency: symbol.currency ?? 'USD',
    }
  }
  if (assetClass === 'forex') {
    const forex = parseForexSymbol(symbol.symbol, symbol.currency)
    if (!forex) {
      throw new RequestError(400, `Unsupported forex pair ${symbol.symbol}`)
    }
    return applyOrderRoutingDestination(toIbForexContract(forex), routingDestination, duration)
  }
  return {
    symbol: symbol.symbol.toUpperCase(),
    secType: SecType.STK,
    exchange:
      duration === 'overnight'
        ? 'OVERNIGHT'
        : normalizeStockRoutingExchange(routingDestination ?? symbol.exchange),
    currency: symbol.currency ?? 'USD',
    ...(symbol.primaryExchange?.trim()
      ? { primaryExch: symbol.primaryExchange.trim().toUpperCase() }
      : {}),
  }
}

export function applyOrderRoutingDestination(
  contract: Contract,
  routingDestination?: string,
  duration?: OrderDuration,
): Contract {
  if (duration === 'overnight') return { ...contract, exchange: 'OVERNIGHT' }
  const normalized = normalizeRoutingDestination(routingDestination)
  return normalized ? { ...contract, exchange: normalized } : contract
}

export function normalizeRoutingDestination(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase()
  if (!normalized) return undefined
  return normalized === 'NASDAQ' ? 'SMART' : normalized
}

export function toIbQuoteContract(symbol: BrokerSymbol, marketDataExchange?: string): Contract {
  const contract = toIbContract(symbol)
  if (!marketDataExchange) return contract
  // A quote venue replaces the listing hint; order routing remains separate.
  const { primaryExch: _listing, ...quoteContract } = contract
  return { ...quoteContract, exchange: marketDataExchange }
}

export function listingMarketDataExchange(symbol: BrokerSymbol): string | undefined {
  const listingExchange = symbol.primaryExchange?.trim().toUpperCase()
  if (!listingExchange || listingExchange === 'SMART') return undefined
  return toIbContract(symbol).exchange === 'SMART' ? listingExchange : undefined
}

export function normalizeStockRoutingExchange(exchange?: string): string {
  const normalized = exchange?.trim().toUpperCase()
  // IBKR exposes NASDAQ as a stock's listing/primary exchange. It is not the
  // API routing destination (ISLAND is the corresponding direct venue), so a
  // generic NASDAQ stock selection must continue to use SmartRouting.
  if (!normalized || normalized === 'NASDAQ') return 'SMART'
  return normalized
}

export function toIbOptionContract(contract: OptionContract): Contract {
  return {
    symbol: contract.underlying.toUpperCase(),
    secType: contract.underlyingSymbolInfo.assetClass === 'futures' ? SecType.FOP : SecType.OPT,
    ...(contract.brokerContractId &&
    Number.isSafeInteger(Number(contract.brokerContractId)) &&
    Number(contract.brokerContractId) > 0
      ? { conId: Number(contract.brokerContractId) }
      : {}),
    lastTradeDateOrContractMonth: normalizeOptionExpiry(contract.expiration),
    strike: contract.strike,
    right: contract.right === 'call' ? OptionType.Call : OptionType.Put,
    multiplier: contract.multiplier,
    exchange: contract.route || contract.exchange || 'SMART',
    currency: contract.currency ?? 'USD',
  }
}

export function normalizeOptionExpiry(expiration: string): string {
  return expiration.replace(/-/g, '')
}

export function normalizeBrokerSymbol(symbol: BrokerSymbol): BrokerSymbol {
  const assetClass =
    symbol.assetClass || symbol.exchange
      ? (resolveAssetClass(symbol.assetClass, symbol.exchange) ?? symbol.assetClass)
      : inferAssetClass(symbol)
  if (assetClass !== 'stock' && assetClass !== 'crypto' && assetClass !== 'forex') {
    return { ...symbol, symbol: symbol.symbol.toUpperCase(), assetClass }
  }
  if (assetClass === 'forex') {
    const forex = parseForexSymbol(symbol.symbol, symbol.currency)
    return {
      symbol: forex ? forexTicker(forex) : symbol.symbol.toUpperCase(),
      exchange: FOREX_EXCHANGE,
      currency: forex?.quote ?? symbol.currency ?? 'USD',
      assetClass,
      sourceSymbol: symbol.sourceSymbol,
      canonicalSymbol: symbol.canonicalSymbol,
    }
  }
  if (assetClass === 'crypto') {
    return {
      symbol: symbol.symbol.toUpperCase(),
      exchange: normalizeCryptoExchange(symbol.exchange),
      currency: symbol.currency ?? 'USD',
      assetClass,
      sourceSymbol: symbol.sourceSymbol,
      canonicalSymbol: symbol.canonicalSymbol,
    }
  }
  return {
    symbol: symbol.symbol.toUpperCase(),
    exchange: symbol.exchange ?? 'SMART',
    currency: symbol.currency ?? 'USD',
    primaryExchange: symbol.primaryExchange,
    assetClass,
    sourceSymbol: symbol.sourceSymbol,
    canonicalSymbol: symbol.canonicalSymbol,
  }
}

export function brokerSymbolKey(symbol: BrokerSymbol): string {
  const normalized = normalizeBrokerSymbol(symbol)
  if (normalized.contractIdentity?.conId)
    return `IBKR:${normalized.contractIdentity.conId}:${normalized.exchange ?? ''}`
  return [
    normalized.assetClass ?? 'stock',
    normalized.symbol,
    normalized.exchange ?? '',
    normalized.currency ?? '',
  ].join(':')
}

export function toMarketSymbol(details: ContractDetails): MarketSymbol | undefined {
  const contract = details.contract
  const type =
    contract.secType === SecType.OPT && contract.exchange === 'FORECASTX'
      ? 'event-contract'
      : toSupportedAssetClass(contract.secType)
  if (!type) return undefined
  if (type !== 'stock' && type !== 'crypto' && type !== 'forex') {
    const canonicalSymbol = contractCanonicalSymbol(contract)
    if (!canonicalSymbol || !contract.exchange) return undefined
    return {
      ticker:
        (type === 'fund' ? contract.symbol?.trim() : contract.localSymbol?.trim()) ||
        contract.symbol?.trim() ||
        canonicalSymbol,
      brokerSymbol: canonicalSymbol,
      canonicalSymbol,
      exchange: contract.exchange,
      currency: contract.currency,
      type,
      name:
        type === 'futures' || type === 'event-contract'
          ? [contract.localSymbol, details.longName ?? details.marketName]
              .filter(Boolean)
              .join(' · ')
          : details.longName?.trim() ||
            (type === 'bond' ? details.descAppend?.trim() : undefined) ||
            details.marketName?.trim() ||
            undefined,
      description: [
        details.longName?.trim() ||
          (type === 'bond' ? details.descAppend?.trim() : undefined) ||
          details.marketName,
        contract.lastTradeDateOrContractMonth,
      ]
        .filter(Boolean)
        .join(' · '),
      minTick: details.minTick,
      contractMultiplier: contract.multiplier,
      ...(type === 'event-contract' &&
      contract.symbol &&
      contract.lastTradeDateOrContractMonth &&
      contract.strike !== undefined &&
      (contract.right === 'C' || contract.right === 'P') &&
      contract.currency
        ? {
            prediction: {
              kind: 'prediction-contract' as const,
              eventId: `FORECASTX:${contract.symbol}:${contract.lastTradeDateOrContractMonth}`,
              marketId: `FORECASTX:${contract.symbol}:${contract.lastTradeDateOrContractMonth}:${contract.strike}`,
              outcomeId: canonicalSymbol,
              eventTitle: details.longName || contract.symbol,
              marketTitle: `${details.longName || contract.symbol} · ${contract.lastTradeDateOrContractMonth} · ${contract.strike}`,
              outcomeLabel: contract.right === 'C' ? ('Yes' as const) : ('No' as const),
              priceConvention: 'probability' as const,
              payout: { amount: 1, currency: contract.currency },
            },
          }
        : {}),
      contractIdentity: nativeContractIdentity(contract),
    }
  }
  if (type === 'forex') {
    const forex = parseForexSymbol(String(contract.symbol ?? ''), contract.currency)
    return forex
      ? {
          ...toForexMarketSymbol(forex, details.longName ?? details.marketName, details.minTick),
          canonicalSymbol: contractCanonicalSymbol(contract),
        }
      : undefined
  }
  const ticker = contract.symbol?.toUpperCase()
  if (!ticker) return undefined
  const exchange =
    type === 'crypto'
      ? normalizeCryptoExchange(contract.exchange)
      : normalizeStockRoutingExchange(contract.exchange)
  return {
    ticker,
    canonicalSymbol: contractCanonicalSymbol(contract),
    exchange,
    primaryExchange: type === 'stock' ? contract.primaryExch : undefined,
    name: details.longName ?? details.marketName,
    type,
    currency: contract.currency,
    description: details.longName ?? details.marketName,
    minTick: details.minTick,
  }
}

export function toMarketSymbolSearchResult(
  description: ContractDescription,
): MarketSymbol | undefined {
  const contract = description.contract
  if (!contract) return undefined
  const type = toSupportedAssetClass(contract.secType)
  if (!type) return undefined
  if (type !== 'stock' && type !== 'crypto' && type !== 'forex') return undefined
  const currency = contract.currency
  if (type === 'forex') {
    const forex = parseForexSymbol(String(contract.symbol ?? ''), currency)
    return forex
      ? {
          ...toForexMarketSymbol(forex, contract.description ?? contract.localSymbol),
          canonicalSymbol: contractCanonicalSymbol(contract),
        }
      : undefined
  }
  const ticker = contract.symbol?.toUpperCase()
  if (!ticker) return undefined
  const exchange =
    type === 'crypto'
      ? normalizeCryptoExchange(contract.exchange)
      : normalizeStockRoutingExchange(contract.exchange)
  return {
    ticker,
    canonicalSymbol: contractCanonicalSymbol(contract),
    exchange,
    primaryExchange: type === 'stock' ? contract.primaryExch : undefined,
    name: contract.description ?? contract.localSymbol,
    type,
    currency,
    description: contract.description ?? contract.localSymbol,
    minTick: undefined,
  }
}

export function parseForexSymbol(
  value: string,
  quoteCurrency?: string,
): { base: string; quote: string } | undefined {
  const compact = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
  const quote = quoteCurrency?.trim().toUpperCase()
  if (
    compact.length === 3 &&
    quote &&
    FOREX_CODES.has(compact) &&
    FOREX_CODES.has(quote) &&
    compact !== quote
  ) {
    return { base: compact, quote }
  }
  if (compact.length !== 6) return undefined
  const base = compact.slice(0, 3)
  const inferredQuote = compact.slice(3, 6)
  if (!FOREX_CODES.has(base) || !FOREX_CODES.has(inferredQuote) || base === inferredQuote)
    return undefined
  return { base, quote: inferredQuote }
}

function forexTicker(pair: { base: string; quote: string }): string {
  return `${pair.base}${pair.quote}`
}

export function toForexMarketSymbol(
  pair: { base: string; quote: string },
  name?: string,
  minTick?: number,
): MarketSymbol {
  const ticker = forexTicker(pair)
  return {
    ticker,
    exchange: FOREX_EXCHANGE,
    name: name ?? `${pair.base}/${pair.quote}`,
    type: 'forex',
    currency: pair.quote,
    description: `${pair.base}/${pair.quote} · IDEALPRO Forex`,
    minTick,
  }
}

export function toIbForexContract(pair: { base: string; quote: string }): Contract {
  return {
    symbol: pair.base,
    secType: SecType.CASH,
    exchange: FOREX_EXCHANGE,
    currency: pair.quote,
  }
}

export function searchForexSymbols(query: string): MarketSymbol[] {
  const compactQuery = query.replace(/[^A-Z]/g, '')
  const exact = parseForexSymbol(compactQuery)
  const candidates = exact ? [forexTicker(exact), ...MAJOR_FOREX_PAIRS] : MAJOR_FOREX_PAIRS
  return [...new Set(candidates)]
    .filter((pair) => pair.includes(compactQuery))
    .map((pair) => parseForexSymbol(pair))
    .filter((pair): pair is { base: string; quote: string } => Boolean(pair))
    .map((pair) => toForexMarketSymbol(pair))
}

export function uniqueMarketSymbols(symbols: MarketSymbol[]): MarketSymbol[] {
  const seen = new Set<string>()
  const unique: MarketSymbol[] = []
  for (const symbol of symbols) {
    const key =
      symbol.canonicalSymbol ??
      `${symbol.type ?? 'unknown'}:${symbol.ticker}:${symbol.exchange ?? ''}:${symbol.currency ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(symbol)
  }
  return unique
}

export function fromIbSymbol(contract: Contract): BrokerSymbol {
  return {
    ...fromIbSymbolDetails(contract),
    canonicalSymbol: contractCanonicalSymbol(contract),
    contractIdentity: nativeContractIdentity(contract),
  }
}

export function nativeContractId(value: string): number | undefined {
  const match = /^IBKR:([1-9][0-9]*)$/.exec(value)
  const id = match ? Number(match[1]) : undefined
  return id !== undefined && Number.isSafeInteger(id) ? id : undefined
}

function nativeContractIdentity(contract: Contract): NonNullable<BrokerSymbol['contractIdentity']> {
  return {
    securityType: String(contract.secType ?? ''),
    conId: contract.conId,
    localSymbol: contract.localSymbol,
    expiry: contract.lastTradeDateOrContractMonth ?? contract.lastTradeDate,
    tradingClass: contract.tradingClass,
    multiplier: contract.multiplier,
    strike: contract.strike,
    right: contract.right === undefined ? undefined : String(contract.right),
  }
}

function contractCanonicalSymbol(contract: Contract): string | undefined {
  return Number.isInteger(contract.conId) && Number(contract.conId) > 0
    ? `IBKR:${contract.conId}`
    : undefined
}

function fromIbSymbolDetails(contract: Contract): BrokerSymbol {
  if (isOptionSecType(contract.secType)) {
    return {
      symbol: String(contract.symbol ?? '').toUpperCase(),
      exchange: contract.exchange ?? 'SMART',
      currency: contract.currency ?? 'USD',
      assetClass:
        contract.exchange === 'FORECASTX'
          ? 'event-contract'
          : contract.secType === SecType.FOP
            ? 'futures-option'
            : 'option',
    }
  }
  if (isComboSecType(contract.secType)) {
    return {
      symbol: String(contract.symbol ?? '').toUpperCase(),
      exchange: contract.exchange ?? 'SMART',
      currency: contract.currency ?? 'USD',
      assetClass: 'option-combo',
    }
  }
  const assetClass = toSupportedAssetClass(contract.secType)
  if (!assetClass) {
    const securityType = String(contract.secType ?? '').toUpperCase()
    const classifications: Record<string, string> = {
      FUT: 'futures',
      FOP: 'futures-option',
      IND: 'index',
      BOND: 'bond',
      FUND: 'fund',
      WAR: 'warrant',
      CFD: 'cfd',
      CMDTY: 'commodity',
      CONTFUT: 'continuous-futures',
    }
    return {
      symbol: String(contract.symbol ?? '').toUpperCase(),
      exchange: contract.exchange,
      currency: contract.currency,
      assetClass: classifications[securityType] ?? 'unknown',
      contractIdentity: {
        securityType,
        conId: contract.conId,
        localSymbol: contract.localSymbol,
        expiry: contract.lastTradeDateOrContractMonth ?? contract.lastTradeDate,
        tradingClass: contract.tradingClass,
        multiplier: contract.multiplier,
        strike: contract.strike,
        right: contract.right === undefined ? undefined : String(contract.right),
      },
    }
  }
  if (assetClass === 'forex') {
    const pair = parseForexSymbol(String(contract.symbol ?? ''), contract.currency)
    return {
      symbol: pair ? forexTicker(pair) : String(contract.symbol ?? '').toUpperCase(),
      exchange: FOREX_EXCHANGE,
      currency: pair?.quote ?? contract.currency,
      assetClass,
    }
  }
  return {
    symbol: String(contract.symbol ?? '').toUpperCase(),
    exchange:
      assetClass === 'crypto'
        ? normalizeCryptoExchange(contract.exchange)
        : (contract.exchange ?? 'SMART'),
    currency: contract.currency,
    assetClass,
    primaryExchange: assetClass === 'stock' ? contract.primaryExch : undefined,
  }
}

export function fromIbOptionContract(contract: Contract): OptionContract | undefined {
  if (!isOptionSecType(contract.secType) || contract.exchange === 'FORECASTX') return undefined
  const right = String(contract.right ?? '').toUpperCase()
  if (right !== 'C' && right !== 'CALL' && right !== 'P' && right !== 'PUT') return undefined
  const underlying = String(contract.symbol ?? '').toUpperCase()
  return {
    underlying,
    underlyingSymbolInfo: withBrokerSourceSymbol({
      symbol: underlying,
      exchange: contract.exchange ?? 'SMART',
      currency: contract.currency ?? 'USD',
      assetClass: contract.secType === SecType.FOP ? 'futures' : undefined,
      primaryExchange: contract.primaryExch,
    }),
    expiration: denormalizeOptionExpiry(
      String(contract.lastTradeDateOrContractMonth ?? contract.lastTradeDate ?? ''),
    ),
    strike: Number(contract.strike ?? 0),
    right: right === 'C' || right === 'CALL' ? 'call' : 'put',
    multiplier: Number(contract.multiplier ?? 100),
    exchange: contract.exchange,
    route: contract.exchange,
    currency: contract.currency ?? 'USD',
    symbol: contract.localSymbol,
    brokerContractId: contract.conId,
  }
}

export function fromIbOptionLegs(contract: Contract): OptionOrderLegDraft[] {
  if (isOptionSecType(contract.secType)) {
    const optionContract = fromIbOptionContract(contract)
    return optionContract
      ? [
          {
            contract: optionContract,
            side: 'buy',
            positionEffect: 'open',
            quantity: 1,
            ratio: 1,
          },
        ]
      : []
  }
  return []
}

function isOptionSecType(secType: Contract['secType']): boolean {
  return secType === SecType.OPT || secType === SecType.FOP
}

function isComboSecType(secType: Contract['secType']): boolean {
  return String(secType) === String(SecType.BAG)
}

export function denormalizeOptionExpiry(value: string): string {
  const compactDate = /^(\d{8})(?:\b|\s)/.exec(value)?.[1]
  if (compactDate) {
    return `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`
  }
  return value
}
