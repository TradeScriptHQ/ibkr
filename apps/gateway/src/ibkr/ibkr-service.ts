import type {
  BrokerAccountCurrencyConversion,
  BrokerInstrumentDetails,
} from '@ibkr-terminal/contracts'
import type { Contract, ContractDescription, ContractDetails } from '@stoqey/ib'
import { type BarSizeSetting, EventName, type IBApi, MarketDataType, SecType } from '@stoqey/ib'
import { OrderIdAllocator } from '../tws/order-id-allocator.js'
import { resolveAccountCurrencyConversion } from './account-currency-conversion.js'
import { AccountSubscriptions } from './account-subscriptions.js'
import { isIbRequestWarning } from './broker-errors.js'
import type { BridgeConfig } from './config.js'
import {
  fromIbSymbol,
  nativeContractId,
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
import { MarketStreams, type StreamClaimRequest, type TapeRange } from './market-streams.js'
import { positiveInteger } from './numbers.js'
import type { IbSecDefOptionParameters } from './option-chain.js'
import { type OptionChainRequest, OptionChains } from './option-chains.js'
import { OrderExecution } from './order-execution.js'
import { authoritativePriceIncrements, selectedMarketRuleId } from './order-price-increments.js'
import type { PaperOwnershipJournal } from './paper-ownership-journal.js'
import { installContractPipDefinitions } from './pip-definitions.js'
import { QuoteSubscriptions } from './quote-subscriptions.js'
import { MarketDataError, RequestError } from './request-error.js'
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
  PaperOwnershipRecovery,
  PlaceOrderResult,
  PositionCloseOptions,
  SymbolSearchResult,
} from './types.js'

const CONTRACT_DETAILS_TIMEOUT_MS = 12000
const OPTION_CHAIN_TIMEOUT_MS = 12000
const SYMBOL_SEARCH_TIMEOUT_MS = 3000
export class IbkrService {
  beginOrderReconciliation(): void {
    this.brokerAuthorityRevision += 1
    this.orders.beginReconciliation()
    this.accounts.beginReconciliation()
  }
  finishOrderReconciliation(): void {
    this.orders.finishReconciliation()
    this.accounts.finishReconciliation()
  }
  setMarketDataReady(ready: boolean): void {
    this.marketReadinessControlled = true
    if (this.marketDataReady === ready) return
    this.brokerAuthorityRevision += 1
    this.marketDataReady = ready
    if (ready) {
      this.restoreDesiredMarketSubscriptions()
    } else {
      this.invalidateMarketSubscriptions(
        'IBKR is unavailable; waiting for complete reconciliation.',
      )
    }
  }
  private marketDataReady = true
  private brokerAuthorityRevision = 0
  private marketReadinessControlled = false
  private readonly orders: OrderExecution
  private readonly accounts: AccountSubscriptions
  private readonly options: OptionChains
  private readonly quotes: QuoteSubscriptions
  private readonly requests: IbkrRequests
  private readonly qualifiedNativeOptions = new Map<number, BrokerSymbol>()
  private readonly fxQualifications = new Map<
    string,
    { revision: number; result: Promise<ContractDetails[]> }
  >()
  private readonly streams: MarketStreams

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: BrokerStateStore,
    private readonly ib: IBApi,
    orderIds = new OrderIdAllocator(),
    ownership?: PaperOwnershipJournal,
  ) {
    installContractPipDefinitions(this.config.contractPipDefinitions ?? [])
    this.requests = new IbkrRequests(
      this.ib,
      () => this.store.getState().connectionStatus === 'connected',
      orderIds,
    )
    this.quotes = new QuoteSubscriptions(this.ib, this.store, () => this.allocateRequestId())
    this.streams = new MarketStreams(this.ib, this.store, () => this.allocateRequestId())
    this.orders = new OrderExecution(
      this.ib,
      this.config,
      this.store,
      {
        requestContractDetails: (...args) => this.requestContractDetails(...args),
        requestMarketRule: (...args) => this.requests.requestMarketRule(...args),
      },
      (symbol) => this.quotes.getQuotes([symbol], { maxAgeMs: 30_000 })[0],
      orderIds,
      ownership,
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
    this.accounts = new AccountSubscriptions(
      this.ib,
      this.store,
      (contract, symbol) => this.orders.symbolFromContract(contract, symbol),
      () => this.allocateRequestId(),
      this.config.allowedAccountIds,
    )
    this.registerHandlers()
  }

  /** Whether IBKR reports that another session is using this account's live market data. */
  competingLiveSessionReported(): boolean {
    return this.quotes.competingLiveSessionReported()
  }

  getQuotes(symbols: BrokerSymbol[], options: { maxAgeMs?: number } = {}): MarketQuote[] {
    return this.quotes.getQuotes(
      symbols.map((symbol) => this.knownNativeOptionSymbol(symbol)),
      options,
    )
  }

  async getQualifiedQuotes(
    symbols: BrokerSymbol[],
    options: { maxAgeMs?: number } = {},
  ): Promise<MarketQuote[]> {
    return this.getQuotes(
      await Promise.all(symbols.map((symbol) => this.qualifyNativeOptionSymbol(symbol))),
      options,
    )
  }

  async getAccountCurrencyConversion(
    accountId: string,
    fromCurrency: string,
  ): Promise<BrokerAccountCurrencyConversion> {
    const account = this.store.getState().accounts.find((item) => item.id === accountId)
    if (!account || !this.config.allowedAccountIds.includes(accountId))
      throw new RequestError(403, 'Risk conversion requires an allowed current broker account.')
    const toCurrency = account.currency
    const authorityRevision = this.brokerAuthorityRevision
    return resolveAccountCurrencyConversion(fromCurrency, toCurrency, {
      requestContractDetails: (contract, timeoutMs) => this.qualifyFxPair(contract, timeoutMs),
      getQuotes: (symbols, options) => this.quotes.getQuotes(symbols, options),
      assertCurrent: () => {
        const current = this.store.getState()
        if (
          authorityRevision !== this.brokerAuthorityRevision ||
          current.connectionStatus !== 'connected' ||
          !this.marketDataReady ||
          current.accounts.find((item) => item.id === accountId)?.currency !== toCurrency
        )
          throw new RequestError(503, 'Broker account or connection changed during FX conversion.')
      },
    })
  }

  /**
   * FX pairs are listed in one direction only (EUR.USD, never USD.EUR), so conversion probes the
   * missing direction first and IBKR answers it with error 200. Remember each definitive answer
   * for the current broker authority so every valuation does not repeat that failing request.
   */
  private qualifyFxPair(contract: Contract, timeoutMs: number): Promise<ContractDetails[]> {
    const key = `${contract.symbol}.${contract.currency}`
    const cached = this.fxQualifications.get(key)
    if (cached?.revision === this.brokerAuthorityRevision) return cached.result
    const result = this.requests.requestContractDetails(contract, timeoutMs)
    this.fxQualifications.set(key, { revision: this.brokerAuthorityRevision, result })
    result.catch((error: unknown) => {
      // Timeouts and disconnects are not answers about the pair; only "no such contract" is.
      if (
        !(error instanceof RequestError && error.statusCode === 404) &&
        this.fxQualifications.get(key)?.result === result
      )
        this.fxQualifications.delete(key)
    })
    return result
  }

  private knownNativeOptionSymbol(symbol: BrokerSymbol): BrokerSymbol {
    const conId = nativeContractId(symbol.symbol)
    if (symbol.assetClass !== 'option' || !conId) return symbol
    const known =
      this.qualifiedNativeOptions.get(conId) ??
      [
        ...this.store.getState().orders.map((order) => order.symbol),
        ...this.store.getState().positions.map((position) => position.symbol),
        ...this.store.getState().executions.map((execution) => execution.symbol),
      ].find(
        (candidate) =>
          candidate.contractIdentity?.conId === conId &&
          ['OPT', 'FOP'].includes(candidate.contractIdentity.securityType ?? '') &&
          ['option', 'futures-option'].includes(candidate.assetClass ?? ''),
      )
    if (!known) {
      if (symbol.contractIdentity?.securityType === 'OPT') return symbol
      throw new RequestError(
        409,
        'Resolve the exact IBKR option contract before requesting its prices.',
      )
    }
    if (
      (symbol.canonicalSymbol && nativeContractId(symbol.canonicalSymbol) !== conId) ||
      (symbol.contractIdentity?.conId !== undefined && symbol.contractIdentity.conId !== conId) ||
      (symbol.contractIdentity?.securityType &&
        symbol.contractIdentity.securityType !== known.contractIdentity?.securityType) ||
      (symbol.currency && symbol.currency !== known.currency)
    ) {
      throw new RequestError(409, 'Requested option has a different contract identity.')
    }
    return {
      ...known,
      ...symbol,
      assetClass: known.assetClass,
      contractIdentity: known.contractIdentity,
      exchange: symbol.exchange ?? known.exchange,
      currency: symbol.currency ?? known.currency,
    }
  }

  private async qualifyNativeOptionSymbol(symbol: BrokerSymbol): Promise<BrokerSymbol> {
    const conId = nativeContractId(symbol.symbol)
    if (symbol.assetClass !== 'option' || !conId) return symbol
    if (!this.qualifiedNativeOptions.has(conId)) await this.resolveSymbol(symbol.symbol, symbol)
    return this.knownNativeOptionSymbol(symbol)
  }

  async previewOrder(draft: OrderDraft, context: BrokerContext = {}): Promise<OrderPreviewResult> {
    return this.orders.previewOrder(
      { ...draft, symbol: await this.qualifyNativeOptionSymbol(draft.symbol) },
      context,
    )
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
    this.accounts.subscribeAccountPnl(accountId)
    this.store.addMessage('info', `Active account changed to ${accountId}`)
    return account
  }

  async placeOrder(draft: OrderDraft, context: BrokerContext = {}): Promise<PlaceOrderResult> {
    return this.orders.placeOrder(
      { ...draft, symbol: await this.qualifyNativeOptionSymbol(draft.symbol) },
      context,
    )
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

  paperOwnershipRecovery(ownerId: string): PaperOwnershipRecovery {
    return this.orders.paperOwnershipRecovery(ownerId)
  }

  reconcilePaperOwnership(ownerId: string): Promise<PaperOwnershipRecovery> {
    return this.orders.reconcilePaperOwnership(ownerId)
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
    const forexMatches =
      !filter.assetClass || filter.assetClass === 'forex' ? searchForexSymbols(normalized) : []
    const exactForex = parseForexSymbol(normalized)
    const matches = await this.requestMatchingSymbols(normalized, SYMBOL_SEARCH_TIMEOUT_MS)
    return uniqueMarketSymbols([
      ...forexMatches.filter(
        (symbol) => exactForex && symbol.ticker === `${exactForex.base}${exactForex.quote}`,
      ),
      ...matches
        .map(toMarketSymbolSearchResult)
        .filter(
          (symbol): symbol is MarketSymbol =>
            Boolean(symbol) && (!filter.assetClass || symbol?.type === filter.assetClass),
        ),
      ...forexMatches,
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
      if (conId && resolved.contractIdentity?.conId !== conId)
        throw new RequestError(409, 'Resolved IBKR contract has a different contract identity')
      if (
        identity.assetClass &&
        resolved.type !== identity.assetClass &&
        !(
          identity.assetClass === 'option' &&
          resolved.type === 'futures-option' &&
          conId &&
          resolved.contractIdentity?.conId === conId &&
          resolved.contractIdentity.securityType === 'FOP'
        )
      )
        throw new RequestError(409, 'Resolved IBKR contract has a different instrument type')
      if (conId && (resolved.type === 'option' || resolved.type === 'futures-option')) {
        const actualContract = details.find((detail) => detail.contract.conId === conId)?.contract
        if (actualContract) this.qualifiedNativeOptions.set(conId, fromIbSymbol(actualContract))
      }
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
      nativePriceMagnifier: details.priceMagnifier,
      nativeContractMultiplier:
        details.contract.multiplier == null ? undefined : String(details.contract.multiplier),
      nativeMarketRuleIds: details.marketRuleIds,
      nativeValidExchanges: details.validExchanges,
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
      toIbContract(
        await this.qualifyNativeOptionSymbol({
          symbol: normalized,
          exchange: params.exchange,
          currency: params.currency,
          primaryExchange: params.primaryExchange,
          assetClass: params.assetClass,
        }),
      ),
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
    if (conId && symbol.contractIdentity?.conId !== conId)
      throw new RequestError(409, 'Resolved IBKR contract has a different contract identity')
    if (
      params.assetClass &&
      symbol.type !== params.assetClass &&
      !(
        params.assetClass === 'option' &&
        symbol.type === 'futures-option' &&
        conId &&
        symbol.contractIdentity?.conId === conId &&
        symbol.contractIdentity.securityType === 'FOP'
      )
    )
      throw new RequestError(409, 'Resolved IBKR contract has a different instrument type')
    if (conId && (symbol.type === 'option' || symbol.type === 'futures-option')) {
      this.qualifiedNativeOptions.set(conId, fromIbSymbol(contractDetails.contract))
    }
    return { symbol, contract: contractDetails.contract, details: contractDetails }
  }

  getMarketDepth(symbol: BrokerSymbol, rows = 20, claim?: StreamClaimRequest) {
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    return this.streams.depth(symbol, positiveInteger(rows) ?? 20, claim)
  }

  getTimeAndSales(
    symbol: BrokerSymbol,
    limit = 200,
    claim?: StreamClaimRequest,
    range?: TapeRange,
  ) {
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    return this.streams.tape(symbol, positiveInteger(limit) ?? 200, claim, range)
  }

  /** Keep a window's depth and tape claims alive while its event connection is open. */
  connectStreamClient(clientId: string): () => void {
    return this.streams.connectClient(clientId)
  }

  releaseStreamClaims(claimIds: readonly string[], clientId: string | undefined): void {
    this.streams.release(claimIds, clientId)
  }

  private readonly marketDataConnection = new MarketDataConnectionTracker()

  private registerHandlers(): void {
    this.ib.on(EventName.connected, () => {
      this.brokerAuthorityRevision += 1
      this.store.setMarketDataConnection(this.marketDataConnection.reset())
      this.store.setConnectionStatus('connected', `IBKR ${this.config.ibkrMode} API connected`)
      this.ib.reqMarketDataType(MarketDataType.DELAYED_FROZEN)
      this.accounts.subscribePortfolioAccount(this.store.getState().activeAccountId)
      if (this.marketDataReady && !this.marketReadinessControlled)
        this.restoreDesiredMarketSubscriptions()
    })
    this.ib.on(EventName.disconnected, () => {
      this.brokerAuthorityRevision += 1
      this.store.setMarketDataConnection(this.marketDataConnection.reset())
      this.invalidateMarketSubscriptions(
        'TWS disconnected; waiting to restore market subscriptions.',
      )
      this.options.clear()
      this.accounts.clear()
      this.streams.disconnected()
      const message = `IBKR ${this.config.ibkrMode} API disconnected`
      this.store.setConnectionStatus('disconnected', message)
    })
    const handleError = (error: Error, code?: number, requestId?: number) => {
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
        if (this.marketDataReady && !this.marketReadinessControlled)
          this.restoreDesiredMarketSubscriptions(error.message, code)
        return
      }
      if (code === 2100) {
        this.accounts.portfolioSubscriptionLost()
        this.store.addDiagnostic('warning', `${error.message}${suffix}`)
        return
      }
      if (requestId != null && this.streams.handleError(error, code, requestId, suffix)) return
      if (this.quotes.handleQuoteError(error, code, requestId, suffix)) return
      if (this.options.handleOptionQuoteError(error, code, requestId, suffix)) {
        return
      }
      if (this.orders.previews.rejectWhatIfPreviewError(error, code, requestId, suffix)) {
        return
      }
      if (requestId != null && this.requests.ownsRequestId(requestId)) {
        this.store.addDiagnostic('warning', `${error.message}${suffix}`)
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
    }
    this.ib.on(EventName.error, handleError)
    this.ib.on(EventName.info, (message: string, code: number) => {
      handleError(new Error(message), Number(code), -1)
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
        this.streams.handleTick(reqId, time, price, size, exchange, specialConditions)
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
        this.streams.handleDepthUpdate(reqId, position, operation, side, price, size)
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
        this.streams.handleDepthUpdate(reqId, position, operation, side, price, size, marketMaker)
      },
    )
  }

  private invalidateMarketSubscriptions(message: string): void {
    const cancelActive = this.ib.isConnected
    this.quotes.clearQuoteSubscriptions(message, cancelActive)
    this.options.optionQuoteStreams.suspend(cancelActive)
    this.streams.invalidate(message)
  }

  private restoreDesiredMarketSubscriptions(
    message = 'IBKR reconciliation complete; restoring market subscriptions.',
    code?: number,
  ): void {
    this.quotes.restore()
    this.options.restoreQuoteStreams()
    this.streams.restore(message, code)
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
    const marketRuleId = selectedMarketRuleId(
      details,
      requestedExchange ?? details.contract.exchange,
    )
    if (marketRuleId === undefined) return undefined
    try {
      return authoritativePriceIncrements(await this.requests.requestMarketRule(marketRuleId))
    } catch (error) {
      this.store.addDiagnostic(
        'warning',
        error instanceof Error ? error.message : `IBKR market rule ${marketRuleId} is unavailable`,
      )
      return undefined
    }
  }

  private async requestHistoricalBars(
    contract: Contract,
    request: { endDateTime: string; duration: string; barSize: BarSizeSetting },
  ): Promise<MarketBar[]> {
    try {
      return await this.requests.requestHistoricalBars(contract, request)
    } catch (error) {
      // Observed: while IBKR reports 10197 to this session, history requests go unanswered.
      if (
        error instanceof MarketDataError &&
        error.code === 'market-data-timeout' &&
        this.quotes.competingLiveSessionReported()
      ) {
        throw new MarketDataError(
          503,
          'market-data-competing-session',
          `IBKR sent no chart history for ${contract.symbol ?? 'this symbol'} while it reports a competing live session (IBKR 10197). Restart TWS or IB Gateway and log in again; if this persists, sign out of IBKR Mobile, Client Portal and any other IBKR login.`,
        )
      }
      throw error
    }
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
