import type { BrokerInstrumentDetails } from '@ibkr-terminal/contracts'
import type { Contract, ContractDescription, ContractDetails } from '@stoqey/ib'
import {
  type BarSizeSetting,
  EventName,
  type IBApi,
  MarketDataType,
  SecType,
  TickByTickDataType,
} from '@stoqey/ib'
import type { OrderIdAllocator } from '../tws/order-id-allocator.js'
import { AccountSubscriptions } from './account-subscriptions.js'
import { isIbRequestWarning } from './broker-errors.js'
import type { BridgeConfig } from './config.js'
import {
  brokerSymbolKey,
  nativeContractId,
  normalizeBrokerSymbol,
  normalizeTicker,
  parseForexSymbol,
  searchForexSymbols,
  toIbContract,
  toIbForexContract,
  toMarketSymbol,
  toMarketSymbolSearchResult,
  uniqueMarketSymbols,
} from './contracts.js'
import { opposingForecastContract } from './forecast-contracts.js'
import { IbkrRequests } from './ibkr-requests.js'
import { formatIbDateTime, toIbBarSize, toIbDurationString } from './market-data.js'
import { MarketDataConnectionTracker } from './market-data-connection.js'
import { positiveInteger } from './numbers.js'
import type { IbSecDefOptionParameters } from './option-chain.js'
import { type OptionChainRequest, OptionChains } from './option-chains.js'
import { OrderExecution } from './order-execution.js'
import { QuoteSubscriptions } from './quote-subscriptions.js'
import { RequestError } from './request-error.js'
import type { ParsedSchedule } from './session-calendar.js'
import { deriveSessionWindows, toMarketSessionInfo } from './session-calendar.js'
import type { BrokerStateStore } from './state-store.js'
import type {
  AccountSummary,
  BarHistoryResult,
  BrokerContext,
  BrokerSymbol,
  MarketBar,
  MarketQuote,
  MarketSessionCalendar,
  MarketSessionInfo,
  MarketSymbol,
  OptionChainResult,
  OptionContract,
  OptionContractResolution,
  OrderDraft,
  OrderPatch,
  OrderPreviewResult,
  PlaceOrderResult,
  PositionCloseOptions,
  SymbolSearchResult,
} from './types.js'

const CONTRACT_DETAILS_TIMEOUT_MS = 12000
const OPTION_CHAIN_TIMEOUT_MS = 12000
const SYMBOL_SEARCH_TIMEOUT_MS = 3000
export class IbkrService {
  private readonly orders: OrderExecution
  private readonly accounts: AccountSubscriptions
  private readonly options: OptionChains
  private readonly quotes: QuoteSubscriptions
  private readonly requests: IbkrRequests
  private marketDepthSubscription?:
    | { reqId: number; symbol: BrokerSymbol; rows: number }
    | undefined
  private tapeSubscription?: { reqId: number; symbol: BrokerSymbol } | undefined
  private tapePrints: Array<{
    time: number
    price: number
    size: number
    venue?: string | undefined
    conditions?: string[] | undefined
    sequence: number
  }> = []
  private tapeRetention = 1_000
  private tapeSequence = 0

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: BrokerStateStore,
    private readonly ib: IBApi,
    orderIds?: OrderIdAllocator,
  ) {
    this.requests = new IbkrRequests(
      this.ib,
      () => this.store.getState().connectionStatus === 'connected',
    )
    this.quotes = new QuoteSubscriptions(this.ib, this.store, () => this.allocateRequestId())
    this.orders = new OrderExecution(
      this.ib,
      this.config,
      this.store,
      {
        requestContractDetails: (...args) => this.requestContractDetails(...args),
      },
      (symbol) => this.quotes.getQuotes([symbol], { maxAgeMs: 30_000 })[0],
      orderIds,
    )
    this.options = new OptionChains(
      this.store,
      this.quotes,
      {
        requestContractDetails: (...args) => this.requestContractDetails(...args),
        requestMarketRule: (...args) => this.requests.requestMarketRule(...args),
        requestSecDefOptParams: (...args) => this.requestSecDefOptParams(...args),
      },
      (contract, symbol) => this.orders.rememberSourceSymbol(contract, symbol),
      this.ib,
      () => this.allocateRequestId(),
    )
    this.accounts = new AccountSubscriptions(this.ib, this.store, (contract, symbol) =>
      this.orders.symbolFromContract(contract, symbol),
    )
    this.registerHandlers()
  }

  getQuotes(symbols: BrokerSymbol[], options: { maxAgeMs?: number } = {}): MarketQuote[] {
    return this.quotes.getQuotes(symbols, options)
  }

  async previewOrder(draft: OrderDraft, context: BrokerContext = {}): Promise<OrderPreviewResult> {
    return this.orders.previewOrder(draft, context)
  }

  async previewModifyOrder(
    orderId: string,
    patch: OrderPatch,
    context: BrokerContext = {},
  ): Promise<OrderPreviewResult> {
    return this.orders.previewModifyOrder(orderId, patch, context)
  }

  setActiveAccount(accountId: string): AccountSummary {
    this.orders.assertAccountAllowed(accountId)
    const account = this.store.getState().accounts.find((candidate) => candidate.id === accountId)
    if (!account) throw new RequestError(404, `Account ${accountId} was not found`)
    this.store.setActiveAccount(accountId)
    this.accounts.subscribePortfolioAccount(accountId)
    this.store.addMessage('info', `Active account changed to ${accountId}`)
    return account
  }

  async placeOrder(draft: OrderDraft, context: BrokerContext = {}): Promise<PlaceOrderResult> {
    return this.orders.placeOrder(draft, context)
  }

  async modifyOrder(
    orderId: string,
    patch: OrderPatch,
    context: BrokerContext = {},
  ): Promise<PlaceOrderResult> {
    return this.orders.modifyOrder(orderId, patch, context)
  }

  cancelOrder(orderId: string): void {
    this.orders.cancelOrder(orderId)
  }

  async previewClosePosition(
    positionId: string,
    context: BrokerContext = {},
    options: PositionCloseOptions = {},
  ): Promise<OrderPreviewResult> {
    return this.orders.previewClosePosition(positionId, context, options)
  }

  async closePosition(
    positionId: string,
    context: BrokerContext = {},
    options: PositionCloseOptions = {},
  ): Promise<PlaceOrderResult> {
    return this.orders.closePosition(positionId, context, options)
  }

  async resolveOptionContract(
    contract: OptionContract,
    accountId?: string,
  ): Promise<OptionContractResolution> {
    return this.options.resolveOptionContract(contract, accountId)
  }

  async getOptionChain(params: OptionChainRequest): Promise<OptionChainResult> {
    return this.options.getOptionChain(params)
  }

  async subscribeOptionChain(
    params: OptionChainRequest,
    listener: (chain: OptionChainResult) => void,
  ): Promise<{ initial: OptionChainResult; unsubscribe: () => void }> {
    return this.options.subscribeOptionChain(params, listener)
  }

  async getOpposingForecastContract(symbol: BrokerSymbol): Promise<BrokerSymbol> {
    return opposingForecastContract(this.requests, symbol)
  }

  private readonly discoveryCache = new Map<
    string,
    { expiresAt: number; value: Promise<ContractDetails[]> }
  >()

  async discoverContracts(params: {
    symbol: string
    securityType: string
    exchange: string
    currency?: string | undefined
    expiry?: string | undefined
    conId?: number | undefined
  }): Promise<ContractDetails[]> {
    const types: Record<string, SecType> = {
      FUT: SecType.FUT,
      IND: SecType.IND,
      OPT: SecType.OPT,
      FOP: SecType.FOP,
      BOND: SecType.BOND,
      FUND: SecType.FUND,
      WAR: SecType.WAR,
      CFD: SecType.CFD,
      CMDTY: SecType.CMDTY,
      CONTFUT: SecType.CONTFUT,
    }
    const secType = types[params.securityType.toUpperCase()]
    if (!secType || !params.symbol.trim() || !params.exchange.trim()) {
      throw new RequestError(
        400,
        'Select an instrument type, symbol and exchange for contract discovery.',
      )
    }
    if (params.conId !== undefined && (!Number.isSafeInteger(params.conId) || params.conId <= 0)) {
      throw new RequestError(400, 'IBKR contract ID must be a positive integer.')
    }
    const contract: Contract = params.conId
      ? { conId: params.conId, secType, exchange: params.exchange.trim().toUpperCase() }
      : {
          symbol: params.symbol.trim().toUpperCase(),
          secType,
          exchange: params.exchange.trim().toUpperCase(),
          ...(params.currency ? { currency: params.currency.toUpperCase() } : {}),
          ...(params.expiry ? { lastTradeDateOrContractMonth: params.expiry } : {}),
        }
    if (this.store.getState().connectionStatus !== 'connected')
      throw new RequestError(503, 'IBKR bridge is not connected')
    const key = JSON.stringify(contract)
    const cached = this.discoveryCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const value = this.requestContractDetails(contract, 30_000).catch((error) => {
      if (this.discoveryCache.get(key)?.value === value) this.discoveryCache.delete(key)
      throw error
    })
    this.discoveryCache.set(key, { value, expiresAt: Date.now() + 60_000 })
    if (this.discoveryCache.size > 64) {
      const oldest = this.discoveryCache.keys().next().value
      if (oldest !== undefined) this.discoveryCache.delete(oldest)
    }
    return value
  }

  async searchSymbols(
    query: string,
    limit = 10,
    filter: { assetClass?: string | undefined; exchange?: string | undefined } = {},
  ): Promise<SymbolSearchResult[]> {
    const normalized = normalizeTicker(query)
    if (!normalized) return []
    const safeLimit = positiveInteger(limit) ?? 10
    if (
      filter.assetClass &&
      [
        'futures',
        'index',
        'fund',
        'event-contract',
        'bond',
        'warrant',
        'commodity',
        'cfd',
      ].includes(filter.assetClass)
    ) {
      if (!filter.exchange)
        throw new RequestError(
          400,
          'Choose an exchange to discover contracts for this instrument type.',
        )
      const securityType = {
        futures: 'FUT',
        index: 'IND',
        fund: 'FUND',
        'event-contract': 'OPT',
        bond: 'BOND',
        warrant: 'WAR',
        commodity: 'CMDTY',
        cfd: 'CFD',
      }[filter.assetClass]
      if (!securityType) throw new RequestError(400, 'Unsupported instrument classification')
      const search = query
        .trim()
        .toUpperCase()
        .match(/^(\S+)(?:\s+(\d{6}|\d{8}))?$/)
      if (!search?.[1])
        throw new RequestError(
          400,
          'Use a root symbol, ROOT YYYYMM expiry, or an exact IBKR contract ID.',
        )
      const details = await this.discoverContracts({
        symbol: search[1],
        securityType,
        exchange: filter.exchange,
        ...(search[2] ? { expiry: search[2] } : {}),
        ...(nativeContractId(search[1]) ? { conId: nativeContractId(search[1]) } : {}),
      })
      return uniqueMarketSymbols(
        details
          .slice()
          .sort((a, b) =>
            (a.contract.lastTradeDateOrContractMonth ?? '').localeCompare(
              b.contract.lastTradeDateOrContractMonth ?? '',
            ),
          )
          .map(toMarketSymbol)
          .filter((item): item is MarketSymbol => Boolean(item)),
      )
        .slice(0, safeLimit)
        .map((symbol) => ({
          symbol,
          displayName: symbol.ticker,
          description: symbol.description,
          provider: 'IBKR',
        }))
    }
    const forexMatches = searchForexSymbols(normalized)
    const matches = await this.requestMatchingSymbols(normalized, SYMBOL_SEARCH_TIMEOUT_MS)
    return uniqueMarketSymbols([
      ...forexMatches,
      ...matches
        .map(toMarketSymbolSearchResult)
        .filter((symbol): symbol is MarketSymbol => Boolean(symbol)),
    ])
      .slice(0, safeLimit)
      .map((symbol) => ({
        symbol,
        displayName: symbol.ticker,
        description:
          symbol.description ?? [symbol.exchange, symbol.currency].filter(Boolean).join(' '),
        provider: 'IBKR',
      }))
  }

  async resolveSymbol(
    symbol: string,
    identity: {
      exchange?: string | undefined
      primaryExchange?: string | undefined
      currency?: string | undefined
      assetClass?: string | undefined
    } = {},
  ): Promise<MarketSymbol> {
    const normalized = normalizeTicker(symbol)
    if (!normalized) {
      throw new RequestError(400, 'Symbol is required')
    }
    if (Object.values(identity).some(Boolean) || nativeContractId(normalized)) {
      const conId = nativeContractId(normalized)
      // A known contract ID can be read even when IBKR omits order-required metadata.
      const details = await this.requestContractDetails(
        conId
          ? { conId, ...(identity.exchange ? { exchange: identity.exchange } : {}) }
          : toIbContract({ symbol: normalized, ...identity }),
      )
      const contracts = new Map(details.map((entry) => [entry.contract.conId, entry]))
      if (contracts.size !== 1) {
        throw new RequestError(
          contracts.size ? 409 : 404,
          contracts.size
            ? 'Instrument is ambiguous; select a currency and primary exchange.'
            : `IBKR could not resolve symbol ${normalized}`,
        )
      }
      const resolved = details.map(toMarketSymbol).find(Boolean)
      if (!resolved) throw new RequestError(400, 'Unsupported instrument type')
      if (identity.assetClass && resolved.type !== identity.assetClass)
        throw new RequestError(409, 'Resolved IBKR contract has a different instrument type')
      return resolved
    }
    const forex = parseForexSymbol(normalized)
    if (forex) {
      const details = await this.requestContractDetails(toIbForexContract(forex))
      const resolved = details.map(toMarketSymbol).find(Boolean)
      if (!resolved) throw new RequestError(404, `IBKR could not resolve forex pair ${normalized}`)
      return resolved
    }
    const matches = await this.requestMatchingSymbols(normalized, SYMBOL_SEARCH_TIMEOUT_MS).catch(
      () => [],
    )
    const matched = matches
      .map(toMarketSymbolSearchResult)
      .find(
        (item): item is MarketSymbol =>
          item != null && item.ticker === normalized && item.currency === 'USD',
      )
    if (matched) return matched

    const details = await this.requestContractDetails({
      symbol: normalized,
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
    })
    const resolved = details.map(toMarketSymbol).find(Boolean)
    if (!resolved) {
      throw new RequestError(404, `IBKR could not resolve symbol ${normalized}`)
    }
    return resolved
  }

  async getInstrumentDetails(params: {
    symbol: string
    exchange?: string | undefined
    primaryExchange?: string | undefined
    currency?: string | undefined
    assetClass?: string | undefined
  }): Promise<BrokerInstrumentDetails> {
    if (
      params.assetClass &&
      ![
        'stock',
        'forex',
        'crypto',
        'futures',
        'index',
        'fund',
        'event-contract',
        'bond',
        'warrant',
        'commodity',
        'cfd',
      ].includes(params.assetClass)
    ) {
      throw new RequestError(400, 'Instrument details are unavailable for this asset class')
    }
    const { symbol, details } = await this.resolveSessionContract(params)
    const priceIncrements = await this.priceIncrementsFor(details, params.exchange)
    return {
      symbol: { ...symbol, ...(priceIncrements ? { priceIncrements } : {}) },
      name: details.longName,
      industry: details.industry,
      category: details.category,
      subcategory: details.subcategory,
      minTick: details.minTick,
      priceIncrements,
      source: 'IBKR contract details',
    }
  }

  async loadBars(params: {
    symbol: string
    exchange?: string | undefined
    primaryExchange?: string | undefined
    currency?: string | undefined
    interval: string
    startTime?: number | undefined
    endTime?: number | undefined
    barCount?: number | undefined
    assetClass?: string | undefined
  }): Promise<BarHistoryResult> {
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    const normalized = normalizeTicker(params.symbol)
    if (!normalized) {
      throw new RequestError(400, 'Symbol is required')
    }
    const interval = toIbBarSize(params.interval)
    const requestedBarCount = Math.max(positiveInteger(params.barCount) ?? 200, 1)
    const endTime = params.endTime && Number.isFinite(params.endTime) ? params.endTime : Date.now()
    const startTime =
      params.startTime && Number.isFinite(params.startTime)
        ? params.startTime
        : endTime - interval.ms * Math.max(requestedBarCount, 50)
    const duration = toIbDurationString(
      Math.max(endTime - startTime, interval.ms * requestedBarCount),
    )
    const returnedBars = await this.requestHistoricalBars(
      toIbContract({
        symbol: normalized,
        exchange: params.exchange,
        currency: params.currency,
        primaryExchange: params.primaryExchange,
        assetClass: params.assetClass,
      }),
      {
        endDateTime: formatIbDateTime(endTime),
        duration,
        barSize: interval.barSize,
      },
    )
    // TWS duration windows are inclusive and can contain boundary bars beyond
    // the caller's requested maximum. The chart contract is an upper bound, so
    // retain the newest bars and never pass an oversized page across it.
    const bars =
      returnedBars.length > requestedBarCount
        ? returnedBars.slice(-requestedBarCount)
        : returnedBars
    return {
      bars,
      hasOlder: returnedBars.length > 0,
      hasNewer: false,
      dataUnavailable: bars.length === 0,
    }
  }

  async resolveSession(params: {
    symbol: string
    exchange?: string | undefined
    primaryExchange?: string | undefined
    currency?: string | undefined
    assetClass?: string | undefined
  }): Promise<MarketSessionInfo> {
    const { symbol, details } = await this.resolveSessionContract(params)
    const priceIncrements = await this.priceIncrementsFor(details, params.exchange)
    return toMarketSessionInfo(
      { ...symbol, ...(priceIncrements ? { priceIncrements } : {}) },
      details,
      Date.now(),
    )
  }

  async resolveSessionCalendar(params: {
    symbol: string
    exchange?: string | undefined
    primaryExchange?: string | undefined
    currency?: string | undefined
    assetClass?: string | undefined
    startTime: number
    endTime: number
  }): Promise<MarketSessionCalendar> {
    if (
      !Number.isFinite(params.startTime) ||
      !Number.isFinite(params.endTime) ||
      params.endTime <= params.startTime
    ) {
      throw new RequestError(400, 'A finite session-calendar range is required')
    }
    const { symbol, contract } = await this.resolveSessionContract(params)
    const [allHours, regularHours] = await Promise.all([
      this.requestHistoricalSchedule(contract, params.startTime, params.endTime, false),
      this.requestHistoricalSchedule(contract, params.startTime, params.endTime, true),
    ])
    const coverage = {
      startTime: Math.max(allHours.startTime, regularHours.startTime),
      endTime: Math.min(allHours.endTime, regularHours.endTime),
    }
    if (coverage.endTime <= coverage.startTime) {
      throw new RequestError(502, 'IBKR returned incompatible session-calendar coverage')
    }
    return {
      symbol,
      timezone: allHours.timezone,
      coverage,
      windows: deriveSessionWindows(allHours.windows, regularHours.windows),
      source: 'ibkr-historical-schedule',
    }
  }

  private async resolveSessionContract(params: {
    symbol: string
    exchange?: string | undefined
    primaryExchange?: string | undefined
    currency?: string | undefined
    assetClass?: string | undefined
  }): Promise<{ symbol: MarketSymbol; contract: Contract; details: ContractDetails }> {
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    const normalized = normalizeTicker(params.symbol)
    if (!normalized) {
      throw new RequestError(400, 'Symbol is required')
    }
    // Metadata reads can qualify by exact conId even when bond licensing omits
    // currency. Order construction still requires the complete trading identity.
    const conId = nativeContractId(normalized)
    const contract: Contract = conId
      ? { conId, ...(params.exchange ? { exchange: params.exchange } : {}) }
      : toIbContract({
          symbol: normalized,
          exchange: params.exchange,
          primaryExchange: params.primaryExchange,
          currency: params.currency,
          assetClass: params.assetClass,
        })
    const details = await this.requestContractDetails(contract)
    const unique = new Map(details.map((item) => [item.contract.conId, item]))
    if (unique.size !== 1)
      throw new RequestError(
        unique.size ? 409 : 404,
        'Select one exact IBKR contract for the session schedule.',
      )
    const contractDetails = details[0]
    if (!contractDetails) throw new RequestError(404, 'IBKR contract details are unavailable.')
    const symbol = toMarketSymbol(contractDetails)
    if (!symbol) throw new RequestError(400, 'Unsupported instrument type')
    if (params.assetClass && symbol.type !== params.assetClass)
      throw new RequestError(409, 'Resolved IBKR contract has a different instrument type')
    return { symbol, contract: contractDetails.contract, details: contractDetails }
  }

  getMarketDepth(symbol: BrokerSymbol, rows = 20) {
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    const normalized = normalizeBrokerSymbol(symbol)
    const boundedRows = positiveInteger(rows) ?? 20
    const key = brokerSymbolKey(normalized)
    const active = this.marketDepthSubscription
    if (!active || brokerSymbolKey(active.symbol) !== key || active.rows !== boundedRows) {
      if (active) this.ib.cancelMktDepth(active.reqId, true)
      const reqId = this.allocateRequestId()
      this.marketDepthSubscription = { reqId, symbol: normalized, rows: boundedRows }
      this.store.setMarketDepth({
        symbol: normalized,
        bids: [],
        asks: [],
        updatedAt: new Date().toISOString(),
      })
      this.ib.reqMktDepth(reqId, toIbContract(normalized), boundedRows, true, [])
      this.store.addDiagnostic('info', `Subscribed market depth for ${normalized.symbol}`)
    }
    return this.store.getState().marketDepth
  }

  getTimeAndSales(symbol: BrokerSymbol, limit = 200) {
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    const normalized = normalizeBrokerSymbol(symbol)
    const requestedLimit = positiveInteger(limit) ?? 200
    this.tapeRetention = Math.max(this.tapeRetention, requestedLimit)
    const active = this.tapeSubscription
    if (!active || brokerSymbolKey(active.symbol) !== brokerSymbolKey(normalized)) {
      if (active) this.ib.cancelTickByTickData(active.reqId)
      const reqId = this.allocateRequestId()
      this.tapeSubscription = { reqId, symbol: normalized }
      this.tapePrints = []
      this.tapeSequence = 0
      this.ib.reqTickByTickData(
        reqId,
        toIbContract(normalized),
        TickByTickDataType.AllLast,
        0,
        false,
      )
      this.store.addDiagnostic('info', `Subscribed time and sales for ${normalized.symbol}`)
    }
    return this.tapePrints.slice(-requestedLimit)
  }

  private readonly marketDataConnection = new MarketDataConnectionTracker()

  private registerHandlers(): void {
    this.ib.on(EventName.connected, () => {
      this.store.setMarketDataConnection(this.marketDataConnection.reset())
      this.store.setConnectionStatus('connected', `IBKR ${this.config.ibkrMode} API connected`)
      this.ib.reqMarketDataType(MarketDataType.DELAYED_FROZEN)
      this.accounts.subscribePortfolioAccount(this.store.getState().activeAccountId)
      this.quotes.restore()
    })
    this.ib.on(EventName.disconnected, () => {
      this.store.setMarketDataConnection(this.marketDataConnection.reset())
      this.quotes.clearQuoteSubscriptions(
        'TWS disconnected; waiting to restore quote subscription.',
      )
      this.options.clear()
      this.accounts.clear()
      this.marketDepthSubscription = undefined
      this.tapeSubscription = undefined
      this.tapePrints = []
      const message = `IBKR ${this.config.ibkrMode} API disconnected`
      this.store.setConnectionStatus('disconnected', message)
    })
    this.ib.on(EventName.error, (error: Error, code?: number, requestId?: number) => {
      const suffix = code ? ` (${code}${requestId != null ? ` req ${requestId}` : ''})` : ''
      const dataConnection = this.marketDataConnection.handle(code, error.message)
      if (dataConnection) {
        this.store.setMarketDataConnection(dataConnection)
        this.store.addDiagnostic(
          dataConnection.status === 'connected' ? 'info' : 'warning',
          `${error.message}${suffix}`,
        )
        if (code !== 1101) return
      }
      if (code === 1101) {
        this.quotes.clearQuoteSubscriptions('IBKR market-data connection restored; resubscribing.')
        this.store.setConnectionStatus('connected', error.message)
        this.quotes.restore()
        this.options.restoreQuoteStreams()
        this.restoreMarketDepth(error.message, code)
        this.restoreTape()
        return
      }
      if (requestId != null && requestId === this.marketDepthSubscription?.reqId) {
        if (code === 316) {
          this.restoreMarketDepth(error.message, code)
          this.store.addDiagnostic('warning', `${error.message}${suffix}`)
          return
        }
        const depth = this.store.getState().marketDepth
        if (depth) {
          this.store.setMarketDepth({
            ...depth,
            ...(code === 317 ? { bids: [], asks: [] } : {}),
            diagnostic: { message: error.message, ...(code == null ? {} : { code }) },
          })
        }
        this.store.addDiagnostic('warning', `${error.message}${suffix}`)
        return
      }
      if (this.quotes.handleQuoteError(error, code, requestId, suffix)) return
      if (this.options.handleOptionQuoteError(error, code, requestId, suffix)) {
        return
      }
      if (this.orders.previews.rejectWhatIfPreviewError(error, code, requestId, suffix)) {
        return
      }
      if (this.orders.rejectOrderForRequestError(error, code, requestId, suffix)) {
        return
      }
      if (isIbRequestWarning(error, code, requestId)) {
        this.store.addDiagnostic('warning', `${error.message}${suffix}`)
        return
      }
      const message = `${error.message}${suffix}`
      this.store.setConnectionStatus('error', message)
    })
    this.ib.on(EventName.tickPrice, (reqId: number, field: number, value: number) => {
      if (this.options.optionQuoteStreams.price(reqId, field, value)) return
      this.quotes.handleTickPrice(reqId, field, value)
    })
    this.ib.on(EventName.tickSize, (reqId: number, field?: number, value?: number) => {
      if (this.options.optionQuoteStreams.size(reqId, field, value)) return
      this.quotes.handleTickSize(reqId, field, value)
    })
    this.ib.on(EventName.marketDataType, (reqId: number, marketDataType: number) => {
      if (this.options.optionQuoteStreams.dataType(reqId, marketDataType)) return
      this.quotes.handleMarketDataType(reqId, marketDataType)
    })
    this.ib.on(
      EventName.tickOptionComputation,
      (
        reqId: number,
        field: number,
        _tickAttrib: number | undefined,
        impliedVolatility?: number,
        delta?: number,
        optionPrice?: number,
        _presentValueDividend?: number,
        gamma?: number,
        vega?: number,
        theta?: number,
      ) => {
        this.options.optionQuoteStreams.computation(
          reqId,
          field,
          impliedVolatility,
          delta,
          optionPrice,
          gamma,
          vega,
          theta,
        )
      },
    )
    this.ib.on(
      EventName.tickByTickAllLast,
      (
        reqId: number,
        _tickType: number,
        time: string,
        price: number,
        size: number,
        _attributes: unknown,
        exchange: string,
        specialConditions: string,
      ) => {
        if (this.tapeSubscription?.reqId !== reqId) return
        const seconds = Number(time)
        this.tapePrints = [
          ...this.tapePrints.slice(-(this.tapeRetention - 1)),
          {
            time: Number.isFinite(seconds) ? seconds * 1_000 : Date.now(),
            price,
            size,
            ...(exchange ? { venue: exchange } : {}),
            ...(specialConditions
              ? { conditions: specialConditions.split(',').filter(Boolean) }
              : {}),
            sequence: ++this.tapeSequence,
          },
        ]
      },
    )
    this.ib.on(
      EventName.updateMktDepth,
      (
        reqId: number,
        position: number,
        operation: number,
        side: number,
        price: number,
        size: number,
      ) => {
        this.handleMarketDepth(reqId, position, operation, side, price, size)
      },
    )
    this.ib.on(
      EventName.updateMktDepthL2,
      (
        reqId: number,
        position: number,
        marketMaker: string,
        operation: number,
        side: number,
        price: number,
        size: number,
      ) => {
        this.handleMarketDepth(reqId, position, operation, side, price, size, marketMaker)
      },
    )
  }

  private handleMarketDepth(
    reqId: number,
    position: number,
    operation: number,
    side: number,
    price: number,
    size: number,
    marketMaker?: string,
  ): void {
    const subscription = this.marketDepthSubscription
    if (!subscription || subscription.reqId !== reqId || position < 0) return
    const current = this.store.getState().marketDepth ?? {
      symbol: subscription.symbol,
      bids: [],
      asks: [],
      updatedAt: new Date().toISOString(),
    }
    const levels = [...(side === 1 ? current.bids : current.asks)]
    if (operation === 2) {
      levels.splice(position, 1)
    } else {
      const level = {
        price,
        size,
        ...(marketMaker ? { marketMaker } : {}),
      }
      if (operation === 0) levels.splice(position, 0, level)
      else levels[position] = level
    }
    this.store.setMarketDepth({
      ...current,
      symbol: subscription.symbol,
      bids: side === 1 ? levels.slice(0, subscription.rows) : current.bids,
      asks: side === 0 ? levels.slice(0, subscription.rows) : current.asks,
      updatedAt: new Date().toISOString(),
    })
  }

  private restoreMarketDepth(message: string, code?: number): void {
    const active = this.marketDepthSubscription
    if (!active) return
    const reqId = this.allocateRequestId()
    this.marketDepthSubscription = { ...active, reqId }
    this.store.setMarketDepth({
      symbol: active.symbol,
      bids: [],
      asks: [],
      updatedAt: new Date().toISOString(),
      diagnostic: { message, ...(code == null ? {} : { code }) },
    })
    this.ib.reqMktDepth(reqId, toIbContract(active.symbol), active.rows, true, [])
  }

  private restoreTape(): void {
    const active = this.tapeSubscription
    if (!active) return
    const reqId = this.allocateRequestId()
    this.tapeSubscription = { ...active, reqId }
    this.tapePrints = []
    this.tapeSequence = 0
    this.ib.reqTickByTickData(
      reqId,
      toIbContract(active.symbol),
      TickByTickDataType.AllLast,
      0,
      false,
    )
  }

  private allocateRequestId(): number {
    return this.requests.allocateRequestId()
  }

  private requestContractDetails(
    contract: Contract,
    timeoutMs = CONTRACT_DETAILS_TIMEOUT_MS,
  ): Promise<ContractDetails[]> {
    return this.requests.requestContractDetails(contract, timeoutMs)
  }

  private requestSecDefOptParams(
    underlyingSymbol: string,
    exchange: string,
    underlyingSecType: SecType,
    underlyingConId: number,
    timeoutMs = OPTION_CHAIN_TIMEOUT_MS,
  ): Promise<IbSecDefOptionParameters[]> {
    return this.requests.requestSecDefOptParams(
      underlyingSymbol,
      exchange,
      underlyingSecType,
      underlyingConId,
      timeoutMs,
    )
  }

  private requestMatchingSymbols(
    pattern: string,
    timeoutMs = SYMBOL_SEARCH_TIMEOUT_MS,
  ): Promise<ContractDescription[]> {
    return this.requests.requestMatchingSymbols(pattern, timeoutMs)
  }

  private async priceIncrementsFor(
    details: ContractDetails,
    requestedExchange?: string,
  ): Promise<Array<{ lowEdge: number; increment: number }> | undefined> {
    const exchanges = String(details.validExchanges ?? '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
    const ids = String(details.marketRuleIds ?? '')
      .split(',')
      .map((value) => Number(value.trim()))
    const exchange = (requestedExchange ?? details.contract.exchange ?? '').trim().toUpperCase()
    const index = exchanges.indexOf(exchange)
    const marketRuleId = index >= 0 ? ids[index] : ids.length === 1 ? ids[0] : undefined
    if (!Number.isSafeInteger(marketRuleId) || Number(marketRuleId) <= 0) return undefined
    try {
      return await this.requests.requestMarketRule(Number(marketRuleId))
    } catch (error) {
      this.store.addDiagnostic(
        'warning',
        error instanceof Error ? error.message : `IBKR market rule ${marketRuleId} is unavailable`,
      )
      return undefined
    }
  }

  private requestHistoricalBars(
    contract: Contract,
    request: { endDateTime: string; duration: string; barSize: BarSizeSetting },
  ): Promise<MarketBar[]> {
    return this.requests.requestHistoricalBars(contract, request)
  }

  private requestHistoricalSchedule(
    contract: Contract,
    startTime: number,
    endTime: number,
    useRegularTradingHours: boolean,
  ): Promise<{
    startTime: number
    endTime: number
    timezone: string
    windows: ParsedSchedule['windows']
  }> {
    return this.requests.requestHistoricalSchedule(
      contract,
      startTime,
      endTime,
      useRegularTradingHours,
    )
  }
}
