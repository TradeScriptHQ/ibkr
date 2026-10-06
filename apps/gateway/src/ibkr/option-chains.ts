import type { Contract, ContractDetails, PriceIncrement } from '@stoqey/ib'
import { type IBApi, SecType } from '@stoqey/ib'
import { isIbMarketDataWarning, isIbOrderWarning, isIbRequestWarning } from './broker-errors.js'
import { mapWithConcurrency } from './concurrency.js'
import {
  denormalizeOptionExpiry,
  fromIbSymbol,
  normalizeOptionExpiry,
  normalizeTicker,
  toIbContract,
  toIbOptionContract,
  withBrokerSourceSymbol,
} from './contracts.js'
import type { IbkrRequests } from './ibkr-requests.js'
import { positiveContractId, positiveInteger, positiveNumber, positivePrice } from './numbers.js'
import type { ResolvedOptionQuoteContract } from './option-chain.js'
import {
  assertOptionIdentity,
  optionContractQuoteKey,
  selectExactOptionDetails,
  selectOptionParameters,
  selectOptionQuoteWindowStrikes,
  toOptionChainContract,
  toResolvedOptionContract,
  uniqueOptionChainContracts,
  withWireOptionExpiry,
} from './option-chain.js'
import { OptionQuoteStreams, type OptionStreamQuote } from './option-quote-streams.js'
import { authoritativePriceIncrements, selectedMarketRuleId } from './order-price-increments.js'
import type { QuoteSubscriptions } from './quote-subscriptions.js'
import { RequestError } from './request-error.js'
import type { BrokerStateStore } from './state-store.js'
import type {
  BrokerSymbol,
  OptionChainContract,
  OptionChainResult,
  OptionContract,
  OptionContractResolution,
} from './types.js'

const OPTION_CATALOG_DETAILS_TIMEOUT_MS = 30000
const OPTION_CATALOG_CONCURRENCY = 2
const OPTION_CATALOG_CACHE_MS = 300_000
const OPTION_QUOTE_CONCURRENCY = 40

export interface OptionChainRequest {
  underlying: string
  underlyingAssetClass?: string | undefined
  underlyingExchange?: string | undefined
  exchange?: string | undefined
  currency?: string | undefined
  expirations?: string[] | undefined
  minStrike?: number | undefined
  maxStrike?: number | undefined
  centerPrice?: number | undefined
  quoteWindowRows?: number | undefined
  maxQuoteContracts?: number | undefined
  tradingClass?: string | undefined
  includeTradingClasses?: boolean | undefined
}

interface ResolvedQuoteTarget {
  key: string
  item: OptionChainContract
  ibContract: ResolvedOptionQuoteContract
}

/** Owns option catalogs, quote streams and their caches for this connection. */
export class OptionChains {
  constructor(
    private readonly store: BrokerStateStore,
    private readonly quotes: Pick<QuoteSubscriptions, 'getQuotes' | 'findQuote'>,
    private readonly requests: Pick<
      IbkrRequests,
      'requestContractDetails' | 'requestMarketRule' | 'requestSecDefOptParams'
    >,
    private readonly rememberSourceSymbol: (contract: Contract, symbol: BrokerSymbol) => void,
    ib: IBApi,
    allocateRequestId: () => number,
  ) {
    this.optionQuoteStreams = new OptionQuoteStreams(
      (id, contract) => ib.reqMktData(id, contract, '', false, false),
      (id) => ib.cancelMktData(id),
      allocateRequestId,
    )
  }
  clear(): void {
    this.optionQuoteStreams.suspend()
    this.optionChainCache.clear()
    this.optionContractCatalogCache.clear()
    this.optionContractCatalogInflight.clear()
    this.resolvedOptionQuoteContracts.clear()
    this.qualifiedCatalogContracts.clear()
  }
  restoreQuoteStreams(): void {
    this.optionQuoteStreams.restore()
  }
  readonly optionQuoteStreams: OptionQuoteStreams

  private readonly resolvedOptionQuoteContracts = new Map<
    string,
    { expiresAt: number; value: Promise<ResolvedOptionQuoteContract> }
  >()

  private readonly qualifiedCatalogContracts = new Map<
    number,
    { expiresAt: number; value: ResolvedOptionQuoteContract }
  >()

  private readonly optionChainCache = new Map<
    string,
    { expiresAt: number; value: OptionChainResult }
  >()

  private readonly optionChainInflight = new Map<string, Promise<OptionChainResult>>()

  private readonly optionContractCatalogCache = new Map<
    string,
    { expiresAt: number; value: ResolvedOptionQuoteContract[] }
  >()

  private readonly optionContractCatalogInflight = new Map<
    string,
    Promise<ResolvedOptionQuoteContract[]>
  >()

  async resolveOptionContract(
    contract: OptionContract,
    accountId?: string,
  ): Promise<OptionContractResolution> {
    if (
      !contract?.underlying ||
      !contract.expiration ||
      !Number.isFinite(contract.strike) ||
      contract.strike <= 0
    ) {
      throw new RequestError(400, 'A complete option contract is required')
    }
    if (!contract.underlyingSymbolInfo?.sourceSymbol?.ticker) {
      throw new RequestError(
        400,
        'Option resolution requires the source-owned underlying symbol identity',
      )
    }
    if (accountId && !this.store.getState().accounts.some((account) => account.id === accountId)) {
      return {
        contract,
        tradable: false,
        reason: `IBKR account ${accountId} was not found`,
      }
    }
    try {
      const resolved = await this.resolveOptionQuoteContract(contract)
      this.rememberSourceSymbol(resolved, contract.underlyingSymbolInfo)
      return {
        contract: toResolvedOptionContract(contract, resolved),
        tradable: true,
      }
    } catch (error) {
      if (error instanceof RequestError && error.statusCode === 404) {
        return {
          contract,
          tradable: false,
          reason: error.message,
        }
      }
      throw error
    }
  }

  async getOptionChain(params: OptionChainRequest): Promise<OptionChainResult> {
    const cacheKey = JSON.stringify({
      ...params,
      expirations: [...(params.expirations ?? [])].sort(),
      // Date-only automatic eligibility changes at midnight, including while a
      // five-minute provider catalog cache is otherwise still fresh.
      ...(params.expirations?.length
        ? {}
        : { catalogDay: new Date(Date.now()).toISOString().slice(0, 10) }),
    })
    const cached = this.optionChainCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return this.refreshOptionChain(cached.value, params)
    }
    const inflight = this.optionChainInflight.get(cacheKey)
    if (inflight) return this.refreshOptionChain(await inflight, params)
    const request = this.loadOptionChain(params)
      .then((value) => {
        this.optionChainCache.set(cacheKey, { expiresAt: Date.now() + 300_000, value })
        return value
      })
      .finally(() => this.optionChainInflight.delete(cacheKey))
    this.optionChainInflight.set(cacheKey, request)
    return this.refreshOptionChain(await request, params)
  }

  async subscribeOptionChain(
    params: OptionChainRequest,
    listener: (chain: OptionChainResult) => void,
  ): Promise<{ initial: OptionChainResult; unsubscribe: () => void }> {
    const chain = await this.getOptionChain(params)
    if (!params.expirations?.length) {
      return { initial: chain, unsubscribe: () => undefined }
    }
    const centerPrice = this.optionCenterPrice(chain, params.centerPrice)
    const targets = await this.resolveQuoteTargets(
      chain.expirations,
      params.maxQuoteContracts,
      centerPrice,
    )
    const quotes = new Map(
      targets.map((target) => [target.key, this.optionQuoteStreams.read(target.ibContract)]),
    )
    const snapshot = () => this.applyQuoteSnapshots(chain, quotes)
    let timer: ReturnType<typeof setTimeout> | undefined
    const targetKeyByContractId = new Map(
      targets.map((target) => [Number(target.ibContract.conId), target.key]),
    )
    const unsubscribeQuotes = this.optionQuoteStreams.subscribeMany(
      targets.map((target) => target.ibContract),
      (contract, quote) => {
        const key = targetKeyByContractId.get(Number(contract.conId))
        if (!key) return
        quotes.set(key, quote)
        if (timer !== undefined) return
        timer = setTimeout(() => {
          timer = undefined
          listener(snapshot())
        }, 16)
      },
    )
    return {
      initial: snapshot(),
      unsubscribe: () => {
        if (timer !== undefined) clearTimeout(timer)
        unsubscribeQuotes()
      },
    }
  }

  private async loadOptionChain(params: OptionChainRequest): Promise<OptionChainResult> {
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    const requestedUnderlying = normalizeTicker(params.underlying)
    if (!requestedUnderlying) throw new RequestError(400, 'Underlying symbol is required')
    const currency = params.currency ?? 'USD'
    const underlyingDetails = await this.requests.requestContractDetails(
      toIbContract({
        symbol: requestedUnderlying,
        assetClass: params.underlyingAssetClass ?? 'stock',
        exchange: params.underlyingExchange ?? 'SMART',
        currency,
      }),
    )
    const unique = new Map(
      underlyingDetails.map((details) => [details.contract.conId, details.contract]),
    )
    if (unique.size !== 1)
      throw new RequestError(
        unique.size ? 409 : 404,
        'Select one exact optionable underlying contract.',
      )
    const underlyingContract = underlyingDetails[0]?.contract
    const underlyingConId = Number(underlyingContract?.conId)
    if (
      !underlyingContract ||
      !Number.isSafeInteger(underlyingConId) ||
      underlyingConId <= 0 ||
      !underlyingContract.symbol
    ) {
      throw new RequestError(404, 'IBKR could not resolve the optionable underlying')
    }
    const underlyingSecType = underlyingContract.secType
    if (
      underlyingSecType !== SecType.STK &&
      underlyingSecType !== SecType.IND &&
      underlyingSecType !== SecType.FUT
    ) {
      throw new RequestError(400, 'Options require a stock, index or futures underlying.')
    }
    const underlying = underlyingContract.symbol
    const underlyingSymbolInfo = withBrokerSourceSymbol(fromIbSymbol(underlyingContract))
    const requestedExchange =
      params.exchange ??
      (underlyingSecType === SecType.FUT ? underlyingContract.exchange : '') ??
      ''
    const optionParams = await this.requests.requestSecDefOptParams(
      underlying,
      requestedExchange === 'SMART' ? '' : requestedExchange,
      underlyingSecType,
      underlyingConId,
    )
    const usableClasses = optionParams.filter(
      (item) => item.expirations.length && item.strikes.length,
    )
    const classExchange =
      requestedExchange && usableClasses.some((item) => item.exchange === requestedExchange)
        ? requestedExchange
        : usableClasses.some((item) => item.exchange === 'SMART')
          ? 'SMART'
          : undefined
    const tradingClasses = [
      ...new Map(
        usableClasses
          .filter(
            (item) =>
              (classExchange === undefined || item.exchange === classExchange) &&
              positiveNumber(Number(item.multiplier)),
          )
          .map((item) => [
            `${item.tradingClass}|${item.exchange}|${item.multiplier}`,
            { id: item.tradingClass, exchange: item.exchange, multiplier: Number(item.multiplier) },
          ]),
      ).values(),
    ].sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        left.exchange.localeCompare(right.exchange) ||
        left.multiplier - right.multiplier,
    )
    if (
      params.includeTradingClasses &&
      params.tradingClass === undefined &&
      new Set(tradingClasses.map((item) => item.id)).size > 1
    ) {
      return {
        underlying,
        exchange: requestedExchange || 'SMART',
        currency,
        tradingClasses,
        expirations: [],
      }
    }
    const selectedParams = selectOptionParameters(
      optionParams,
      requestedExchange,
      params.tradingClass,
    )
    if (!selectedParams) {
      throw new RequestError(404, `IBKR did not return option chain parameters for ${underlying}`)
    }
    const expirations = selectedParams.expirations
      .map(denormalizeOptionExpiry)
      .filter(
        (expiration) => !params.expirations?.length || params.expirations.includes(expiration),
      )
      .sort()
    const underlyingQuote = this.quotes.findQuote(underlyingSymbolInfo)
    const centerPrice =
      positiveNumber(params.centerPrice) ??
      positiveNumber(underlyingQuote?.last) ??
      (positivePrice(underlyingQuote?.bid) && positivePrice(underlyingQuote?.ask)
        ? (underlyingQuote.bid + underlyingQuote.ask) / 2
        : undefined)
    const multiplier = positiveNumber(Number(selectedParams.multiplier))
    if (multiplier === undefined)
      throw new RequestError(409, 'IBKR did not supply a valid option class multiplier.')
    const optionExchange = requestedExchange || 'SMART'
    // reqSecDefOptParams returns independent expiration and strike sets; their cartesian
    // product is not a contract catalog. Qualify the active expiration through IBKR and
    // publish only the exact contracts returned by contractDetails. The initial metadata
    // request loads the nearest strictly future date. Date-only metadata cannot
    // establish a same-day option's native final trading deadline. Explicit
    // selections remain available, including provider-listed historical dates.
    const catalogDay = new Date(Date.now()).toISOString().slice(0, 10)
    const expirationsToLoad = params.expirations?.length
      ? expirations
      : expirations.filter((expiration) => expiration > catalogDay).slice(0, 1)
    const loadedExpirations = await mapWithConcurrency(
      expirationsToLoad,
      OPTION_CATALOG_CONCURRENCY,
      async (expiration) => {
        const details = await this.loadOptionContractCatalog({
          underlying,
          securityType: underlyingSecType === SecType.FUT ? SecType.FOP : SecType.OPT,
          expiration,
          exchange: optionExchange,
          currency,
          multiplier,
          tradingClass: selectedParams.tradingClass,
        })
        const exactContracts = uniqueOptionChainContracts(
          details.map((contract) =>
            toOptionChainContract(contract, {
              underlying,
              underlyingSymbolInfo,
              expiration,
              multiplier,
              route: optionExchange,
              currency,
            }),
          ),
        )
          .filter((item) => params.minStrike == null || item.contract.strike >= params.minStrike)
          .filter((item) => params.maxStrike == null || item.contract.strike <= params.maxStrike)
        const strikes = selectOptionQuoteWindowStrikes(
          [...new Set(exactContracts.map((item) => item.contract.strike))].sort(
            (left, right) => left - right,
          ),
          { centerPrice, quoteWindowRows: params.quoteWindowRows },
        )
        const visibleStrikes = new Set(strikes)
        return [
          expiration,
          exactContracts.filter((item) => visibleStrikes.has(item.contract.strike)),
        ] as const
      },
    )
    const contractsByExpiration = new Map(loadedExpirations)
    const chainExpirations = expirations.map((expiration) => ({
      expiration,
      contracts: contractsByExpiration.get(expiration) ?? [],
    }))

    return {
      underlying,
      exchange: optionExchange,
      currency,
      tradingClass: selectedParams.tradingClass,
      tradingClasses,
      expirations: chainExpirations,
    }
  }

  private async loadOptionContractCatalog(params: {
    underlying: string
    securityType: SecType.OPT | SecType.FOP
    expiration: string
    exchange: string
    currency: string
    multiplier: number
    tradingClass: string
  }): Promise<ResolvedOptionQuoteContract[]> {
    const cacheKey = JSON.stringify(params)
    const cached = this.optionContractCatalogCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const inflight = this.optionContractCatalogInflight.get(cacheKey)
    if (inflight) return inflight
    const request = this.requests
      .requestContractDetails(
        {
          symbol: params.underlying,
          secType: params.securityType,
          lastTradeDateOrContractMonth: normalizeOptionExpiry(params.expiration),
          exchange: params.exchange,
          currency: params.currency,
          multiplier: params.multiplier,
          tradingClass: params.tradingClass,
        },
        OPTION_CATALOG_DETAILS_TIMEOUT_MS,
      )
      .then(async (details) => {
        const resolved = await Promise.all(
          details.map(async (item) => {
            if (!item.contract) return []
            const priceStep = positiveNumber(item.minTick)
            const priceIncrements = await this.priceIncrementsFor(item, params.exchange)
            return [
              {
                ...withWireOptionExpiry(item.contract),
                ...(priceStep === undefined ? {} : { priceStep }),
                ...(priceIncrements ? { priceIncrements } : {}),
              },
            ]
          }),
        )
        const value = resolved.flat()
        for (const contract of value) {
          const id = positiveContractId(contract.conId)
          if (id !== undefined)
            this.qualifiedCatalogContracts.set(id, {
              expiresAt: Date.now() + OPTION_CATALOG_CACHE_MS,
              value: contract,
            })
        }
        this.optionContractCatalogCache.set(cacheKey, {
          expiresAt: Date.now() + OPTION_CATALOG_CACHE_MS,
          value,
        })
        return value
      })
      .finally(() => this.optionContractCatalogInflight.delete(cacheKey))
    this.optionContractCatalogInflight.set(cacheKey, request)
    return request
  }

  private async refreshOptionChain(
    chain: OptionChainResult,
    params: {
      expirations?: string[] | undefined
      centerPrice?: number | undefined
      maxQuoteContracts?: number | undefined
    },
  ): Promise<OptionChainResult> {
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    // Catalog reads must not open the nearest expiry's quotes and evict the selected expiry.
    if (!params.expirations?.length) return chain
    const centerPrice = this.optionCenterPrice(chain, params.centerPrice)
    return {
      ...chain,
      expirations: await this.enrichOptionChainQuotes(
        chain.expirations,
        params.maxQuoteContracts,
        centerPrice,
      ),
    }
  }

  private async enrichOptionChainQuotes(
    expirations: OptionChainResult['expirations'],
    maxQuoteContracts?: number,
    centerPrice?: number,
  ): Promise<OptionChainResult['expirations']> {
    const resolvedContracts = await this.resolveQuoteTargets(
      expirations,
      maxQuoteContracts,
      centerPrice,
    )
    if (resolvedContracts.length === 0) return expirations
    if (this.store.getState().connectionStatus !== 'connected') return expirations
    const quotes = await this.optionQuoteStreams.readManyReady(
      resolvedContracts.map((item) => item.ibContract),
    )
    return this.applyQuoteSnapshots(
      { underlying: '', exchange: '', currency: '', expirations },
      new Map(resolvedContracts.map((resolved, index) => [resolved.key, quotes[index] ?? {}])),
    ).expirations
  }

  private optionCenterPrice(chain: OptionChainResult, requested?: number): number | undefined {
    const underlying = chain.expirations.flatMap((expiration) => expiration.contracts)[0]?.contract
      .underlyingSymbolInfo
    const quote = underlying ? this.quotes.findQuote(underlying) : undefined
    return (
      positiveNumber(requested) ??
      positiveNumber(quote?.last) ??
      (positivePrice(quote?.bid) && positivePrice(quote?.ask)
        ? (quote.bid + quote.ask) / 2
        : undefined)
    )
  }

  private async resolveQuoteTargets(
    expirations: OptionChainResult['expirations'],
    maxQuoteContracts?: number,
    centerPrice?: number,
  ): Promise<ResolvedQuoteTarget[]> {
    const contracts = expirations.flatMap((expiration) => expiration.contracts)
    const quoteLimit = positiveInteger(maxQuoteContracts) ?? contracts.length
    const quoteStrikes = new Set(
      selectOptionQuoteWindowStrikes(
        [...new Set(contracts.map((item) => item.contract.strike))].sort((a, b) => a - b),
        { centerPrice, maxQuoteContracts: quoteLimit },
      ),
    )
    const contractsToQuote = contracts
      .filter((item) => quoteStrikes.has(item.contract.strike))
      .slice(0, quoteLimit)
    const resolved = await mapWithConcurrency(
      contractsToQuote,
      OPTION_QUOTE_CONCURRENCY,
      async (item): Promise<ResolvedQuoteTarget | undefined> => {
        const ibContract = await this.resolveOptionQuoteContract(item.contract).catch(
          () => undefined,
        )
        if (!ibContract) return undefined
        return {
          key: optionContractQuoteKey(item.contract),
          item: {
            ...item,
            contract: toResolvedOptionContract(item.contract, ibContract),
          },
          ibContract,
        }
      },
    )
    return resolved.filter((item): item is ResolvedQuoteTarget => item !== undefined)
  }

  private applyQuoteSnapshots(
    chain: OptionChainResult,
    quotes: ReadonlyMap<string, OptionStreamQuote>,
  ): OptionChainResult {
    return {
      ...chain,
      expirations: chain.expirations.map((expiration) => ({
        ...expiration,
        contracts: expiration.contracts.map((item) => {
          const quote = quotes.get(optionContractQuoteKey(item.contract))
          if (!quote) return item
          const {
            bid: _bid,
            ask: _ask,
            last: _last,
            mark: _mark,
            volume: _volume,
            impliedVolatility: _impliedVolatility,
            delta: _delta,
            gamma: _gamma,
            theta: _theta,
            vega: _vega,
            quoteTimestamp: _quoteTimestamp,
            marketDataType: _marketDataType,
            ...contract
          } = item
          return { ...contract, ...quote }
        }),
      })),
    }
  }

  private async resolveOptionQuoteContract(
    contract: OptionContract,
  ): Promise<ResolvedOptionQuoteContract> {
    const brokerContractId = positiveContractId(contract.brokerContractId)
    if (brokerContractId !== undefined) {
      const qualified = this.qualifiedCatalogContracts.get(brokerContractId)
      if (qualified && qualified.expiresAt > Date.now()) {
        assertOptionIdentity(toIbOptionContract(contract), qualified.value)
        const exchange = contract.route || contract.exchange
        return {
          ...qualified.value,
          ...(exchange ? { exchange } : {}),
        }
      }
    }
    const key = optionContractQuoteKey(contract)
    const cached = this.resolvedOptionQuoteContracts.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const request = this.loadOptionQuoteContract(contract).catch((error) => {
      this.resolvedOptionQuoteContracts.delete(key)
      throw error
    })
    if (this.resolvedOptionQuoteContracts.size >= 1000) this.resolvedOptionQuoteContracts.clear()
    this.resolvedOptionQuoteContracts.set(key, {
      expiresAt: Date.now() + OPTION_CATALOG_CACHE_MS,
      value: request,
    })
    return request
  }

  private async loadOptionQuoteContract(
    contract: OptionContract,
  ): Promise<ResolvedOptionQuoteContract> {
    const query = toIbOptionContract(contract)
    const requestedContractId = positiveContractId(contract.brokerContractId)
    if (requestedContractId !== undefined) query.conId = requestedContractId
    const details = await this.requests.requestContractDetails(query)
    const match = selectExactOptionDetails(details, query)
    const route = contract.route || contract.exchange || match.contract.exchange || 'SMART'
    const priceIncrements = await this.priceIncrementsFor(match, route)
    return {
      ...query,
      ...withWireOptionExpiry(match.contract),
      conId: match.contract.conId,
      exchange: route,
      currency: contract.currency ?? match.contract.currency ?? 'USD',
      ...(positiveNumber(match.minTick) === undefined ? {} : { priceStep: match.minTick }),
      ...(priceIncrements ? { priceIncrements } : {}),
    }
  }

  private async priceIncrementsFor(
    details: ContractDetails,
    exchange: string,
  ): Promise<PriceIncrement[] | undefined> {
    const id = selectedMarketRuleId(details, exchange ?? details.contract.exchange)
    if (id === undefined) return undefined
    try {
      return authoritativePriceIncrements(await this.requests.requestMarketRule(id))
    } catch (error) {
      this.store.addDiagnostic(
        'warning',
        error instanceof Error ? error.message : `IBKR market rule ${id} is unavailable`,
      )
      return undefined
    }
  }

  handleOptionQuoteError(error: Error, code?: number, requestId?: number, suffix = ''): boolean {
    if (requestId == null || !this.optionQuoteStreams.has(requestId)) return false
    if (isIbMarketDataWarning(code)) {
      this.store.addDiagnostic('warning', `Option quote warning: ${error.message}${suffix}`)
      return true
    }
    if (code === 200) {
      this.store.addDiagnostic('warning', `Option quote unavailable: ${error.message}${suffix}`)
      return true
    }
    if (isIbRequestWarning(error, code, requestId) || isIbOrderWarning(code)) {
      this.store.addDiagnostic('warning', `Option quote unavailable: ${error.message}${suffix}`)
      return true
    }
    this.store.addDiagnostic('warning', `Option quote failed: ${error.message}${suffix}`)
    return true
  }
}
