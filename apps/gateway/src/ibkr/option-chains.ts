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
  optionContractQuoteKey,
  selectOptionParameters,
  selectOptionQuoteWindowStrikes,
  toOptionChainContract,
  toResolvedOptionContract,
  uniqueOptionChainContracts,
} from './option-chain.js'
import { OptionQuoteStreams, type OptionStreamQuote } from './option-quote-streams.js'
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
    this.optionQuoteStreams.clear()
    this.optionChainCache.clear()
    this.optionContractCatalogCache.clear()
    this.optionContractCatalogInflight.clear()
    this.resolvedOptionQuoteContracts.clear()
  }
  restoreQuoteStreams(): void {
    this.optionQuoteStreams.restore()
  }
  readonly optionQuoteStreams: OptionQuoteStreams

  private readonly resolvedOptionQuoteContracts = new Map<
    string,
    Promise<ResolvedOptionQuoteContract>
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

  private async loadOptionChain(params: {
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
  }): Promise<OptionChainResult> {
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
    const selectedParams = selectOptionParameters(optionParams, requestedExchange)
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
    const multiplier = Number(selectedParams.multiplier) || 100
    const optionExchange = requestedExchange || 'SMART'
    // reqSecDefOptParams returns independent expiration and strike sets; their cartesian
    // product is not a contract catalog. Qualify the active expiration through IBKR and
    // publish only the exact contracts returned by contractDetails. The initial metadata
    // request loads the nearest expiration; selecting another expiration triggers its own
    // exact catalog request while retaining the full broker-provided expiration list.
    const expirationsToLoad = params.expirations?.length ? expirations : expirations.slice(0, 1)
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
                ...item.contract,
                ...(priceStep === undefined ? {} : { priceStep }),
                ...(priceIncrements ? { priceIncrements } : {}),
              },
            ]
          }),
        )
        const value = resolved.flat()
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
    const quote = this.quotes.findQuote({
      symbol: chain.underlying,
      currency: chain.currency,
      assetClass: 'stock',
    })
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
      return {
        ...toIbOptionContract(contract),
        conId: brokerContractId,
        ...(positiveNumber(contract.priceStep) === undefined
          ? {}
          : { priceStep: contract.priceStep }),
      }
    }
    const key = optionContractQuoteKey(contract)
    const cached = this.resolvedOptionQuoteContracts.get(key)
    if (cached) return cached
    const request = this.loadOptionQuoteContract(contract).catch((error) => {
      this.resolvedOptionQuoteContracts.delete(key)
      throw error
    })
    if (this.resolvedOptionQuoteContracts.size >= 1000) this.resolvedOptionQuoteContracts.clear()
    this.resolvedOptionQuoteContracts.set(key, request)
    return request
  }

  private async loadOptionQuoteContract(
    contract: OptionContract,
  ): Promise<ResolvedOptionQuoteContract> {
    const query = toIbOptionContract(contract)
    const requestedContractId = positiveContractId(contract.brokerContractId)
    if (requestedContractId !== undefined) query.conId = requestedContractId
    const details = await this.requests.requestContractDetails(query)
    const match =
      requestedContractId === undefined
        ? details.find((item) => item.contract?.conId != null)
        : details.find((item) => Number(item.contract?.conId) === requestedContractId)
    if (!match?.contract?.conId) {
      throw new RequestError(
        404,
        `IBKR contract was not found for ${contract.underlying} ${contract.expiration} ${contract.strike} ${contract.right}`,
      )
    }
    const route = contract.route || contract.exchange || match.contract.exchange || 'SMART'
    const priceIncrements = await this.priceIncrementsFor(match, route)
    return {
      ...query,
      ...match.contract,
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
    const exchanges = String(details.validExchanges ?? '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
    const ids = String(details.marketRuleIds ?? '')
      .split(',')
      .map((value) => Number(value.trim()))
    const index = exchanges.indexOf(exchange.trim().toUpperCase())
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
