import type {
  SymbolInfo,
  TradingAccountManagerInfo,
  TradingAccountManagerTableDataRequest,
  TradingBrokerAdapter,
  TradingEquityRequest,
  TradingEvent,
  TradingExecutionEnvironment,
  TradingMarginAvailableRequest,
  TradingOptionContractResolution,
  TradingOrder,
  TradingOrderContext,
  TradingOrderDraft,
  TradingOrderPatch,
  TradingOrderPreviewResult,
  TradingOrdersHistoryRequest,
  TradingPipValueRequest,
  TradingPlaceOrderResult,
  TradingPositionCloseOptions,
  TradingPositionPreviewResult,
  TradingResolveOptionContractRequest,
  TradingState,
  TradingSuggestedQuantityRequest,
  TradingSymbolInfo,
  TradingTicketSettingsRequest,
  TradingTicketUserSettings,
  TradingTradableResult,
} from '@tradescript/pro/sdk'
import { ibkrAccountManagerRows, withIbkrAccountManagerPages } from './account-manager.js'
import {
  providerEnvironmentLabel,
  toBackendPatch,
  toOrderPreviewResult,
  toTradingEvent,
  toTradingOptionContract,
  toTradingOrder,
  toTradingState,
} from './broker-mapping.js'
import {
  ALPACA_ORDER_RULES,
  brokerSessionPath,
  CRYPTO_DURATIONS,
  CRYPTO_ORDER_RULES,
  IBKR_ICEBERG_TICKET_SETTINGS,
  IBKR_ORDER_TICKET_CUSTOM_FIELDS,
  OPTION_ORDER_RULES,
  OPTION_ORDER_TYPES,
  positiveStep,
  priceStepFromSymbol,
  SUPPORTED_DURATIONS,
  SUPPORTED_ORDER_RULES,
  supportsIbkrIceberg,
} from './broker-order-rules.js'
import { gatewayRequest } from './broker-request.js'
import { withoutUndefined } from './defined-fields.js'
import {
  readOrderTicketSettings,
  readSuggestedQuantity,
  suggestedQuantityKey,
  writeOrderTicketSettings,
  writeSuggestedQuantity,
} from './ticket-settings.js'
import type {
  BackendEvent,
  BackendHealth,
  BackendOptionContractResolution,
  BackendOrderPreviewResult,
  BackendPlaceOrderResult,
  BackendState,
} from './types'
import { toBackendDraft, toBackendOptionContract } from './types'

type BrokerTradingSymbolRules = {
  orderTypes?: string | undefined
  supportedDurations: NonNullable<TradingSymbolInfo['supportedDurations']>
  priceStep?: number | undefined
  priceIncrements?: Array<{ lowEdge: number; increment: number }> | undefined
  minQuantity?: number | undefined
  quantityStep?: number | undefined
  contractMultiplier?: number | undefined
  routingDestinations?: TradingSymbolInfo['routingDestinations'] | undefined
  defaultRoutingDestination?: string | undefined
  allOrNone?: TradingSymbolInfo['allOrNone'] | undefined
  oca?: TradingSymbolInfo['oca'] | undefined
}

export interface IbkrHttpBrokerAdapterOptions {
  connectionGeneration?: string

  baseUrl?: string | undefined
  providerName?: 'IBKR' | 'Alpaca' | undefined
  /** Exact backend-owned financial environment, when already known by the host bootstrap. */
  executionEnvironment?: TradingExecutionEnvironment | undefined
  csrfToken?: string | undefined
  createDefaultAccountManagerInfo?: (() => TradingAccountManagerInfo) | undefined
}

export interface IbkrHttpBrokerAdapter extends TradingBrokerAdapter {
  getHealth(): Promise<BackendHealth>
}

export function createIbkrHttpBrokerAdapter(
  options: IbkrHttpBrokerAdapterOptions = {},
): IbkrHttpBrokerAdapter {
  const baseUrl = (options.baseUrl ?? 'http://localhost:8765').replace(/\/+$/, '')
  const providerName = options.providerName ?? 'IBKR'
  const isAlpaca = providerName === 'Alpaca'
  const providerOrderRules = isAlpaca ? ALPACA_ORDER_RULES : SUPPORTED_ORDER_RULES
  const providerOrderTypes = providerOrderRules.map((rule) => rule.type)
  const providerCustomFields = isAlpaca ? [] : IBKR_ORDER_TICKET_CUSTOM_FIELDS
  const csrfToken = options.csrfToken
  const request = <T = unknown>(
    requestBaseUrl: string,
    path: string,
    init: { method?: string | undefined; body?: unknown | undefined } = {},
  ) => gatewayRequest<T>(requestBaseUrl, path, init, csrfToken, options.connectionGeneration)
  const subscribers = new Set<(event: TradingEvent) => void>()
  const marginSubscribers = new Set<{
    request: TradingMarginAvailableRequest
    callback: (marginAvailable: number | undefined) => void
  }>()
  const equitySubscribers = new Set<{
    request: TradingEquityRequest
    callback: (equity: number | undefined) => void
  }>()
  const suggestedQuantitySubscribers = new Set<{
    request: TradingSuggestedQuantityRequest
    callback: (quantity: number | undefined) => void
  }>()
  const symbolRulesCache = new Map<string, { expiresAt: number; value: BrokerTradingSymbolRules }>()
  const symbolRulesInflight = new Map<string, Promise<BrokerTradingSymbolRules>>()
  let eventSource: EventSource | null = null
  let lastState: TradingState | null = null
  let executionEnvironment: TradingExecutionEnvironment | undefined = options.executionEnvironment
  let mutationAuthorityInvalidated = false

  const captureHealth = (health: BackendHealth): BackendHealth => {
    if (mutationAuthorityInvalidated) {
      throw new Error(
        'Trading backend mutation authority is invalidated. Recreate the adapter from current backend health.',
      )
    }
    if (executionEnvironment !== undefined && health.mode !== executionEnvironment) {
      mutationAuthorityInvalidated = true
      throw new Error(
        `Trading backend environment mismatch: expected ${executionEnvironment}, received ${health.mode}.`,
      )
    }
    executionEnvironment = health.mode
    Object.assign(adapter, { executionEnvironment: health.mode })
    return health
  }

  const environmentBoundBody = <T extends Record<string, unknown>>(
    body: T,
  ): T & {
    expectedExecutionEnvironment: TradingExecutionEnvironment
  } => {
    if (mutationAuthorityInvalidated) {
      throw new Error(
        'Trading backend mutation authority is invalidated. Recreate the adapter from current backend health.',
      )
    }
    if (executionEnvironment === undefined) {
      throw new Error(
        'Trading backend mutation authority is unavailable until its exact execution environment is known.',
      )
    }
    return { ...body, expectedExecutionEnvironment: executionEnvironment }
  }

  const emit = (event: TradingEvent) => {
    for (const callback of subscribers) callback(event)
  }

  const userFacingRequest = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      emit({
        type: 'message',
        message: {
          type: 'error',
          text: error instanceof Error ? error.message : `${providerName} request failed.`,
          time: Date.now(),
        },
      })
      throw error
    }
  }

  const publishMarginAvailable = () => {
    for (const subscriber of marginSubscribers) {
      const account =
        lastState?.accounts.find((candidate) => candidate.id === subscriber.request.accountId) ??
        lastState?.accounts.find((candidate) => candidate.id === lastState?.activeAccountId) ??
        lastState?.accounts[0]
      const availableFunds = account?.customFields?.availableFunds
      subscriber.callback(
        typeof availableFunds === 'number' ? availableFunds : account?.balance?.buyingPower,
      )
    }
  }

  const publishEquity = () => {
    for (const subscriber of equitySubscribers) {
      const account =
        lastState?.accounts.find((candidate) => candidate.id === subscriber.request.accountId) ??
        lastState?.accounts.find((candidate) => candidate.id === lastState?.activeAccountId) ??
        lastState?.accounts[0]
      subscriber.callback(account?.balance?.equity)
    }
  }

  const publishAccountValues = () => {
    publishMarginAvailable()
    publishEquity()
  }

  const getBrokerSymbolRules = async (symbol: SymbolInfo): Promise<BrokerTradingSymbolRules> => {
    const path = brokerSessionPath(symbol)
    const cached = symbolRulesCache.get(path)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const existing = symbolRulesInflight.get(path)
    if (existing) return existing
    const pending = request<{
      symbol?:
        | {
            minTick?: number | undefined
            priceIncrements?: Array<{ lowEdge: number; increment: number }> | undefined
          }
        | undefined
      metadata?:
        | {
            minQuantity?: number | undefined
            orderTypes?: string | undefined
            quantityStep?: number | undefined
            contractMultiplier?: number | undefined
            supportedDurations?: TradingSymbolInfo['supportedDurations'] | undefined
            routingDestinations?: TradingSymbolInfo['routingDestinations'] | undefined
            defaultRoutingDestination?: string | undefined
            allOrNone?: TradingSymbolInfo['allOrNone'] | undefined
            oca?: TradingSymbolInfo['oca'] | undefined
          }
        | undefined
    }>(baseUrl, path)
      .then((session) => {
        const brokerDurations = session.metadata?.supportedDurations
        const value = {
          orderTypes: session.metadata?.orderTypes,
          supportedDurations: brokerDurations?.length ? brokerDurations : SUPPORTED_DURATIONS,
          priceStep: positiveStep(session.symbol?.minTick) ?? priceStepFromSymbol(symbol),
          priceIncrements: session.symbol?.priceIncrements,
          minQuantity: positiveStep(session.metadata?.minQuantity),
          quantityStep: positiveStep(session.metadata?.quantityStep),
          contractMultiplier: positiveStep(session.metadata?.contractMultiplier),
          routingDestinations: session.metadata?.routingDestinations,
          defaultRoutingDestination: session.metadata?.defaultRoutingDestination,
          allOrNone: session.metadata?.allOrNone,
          oca: session.metadata?.oca,
        }
        symbolRulesCache.set(path, { expiresAt: Date.now() + 5 * 60_000, value })
        return value
      })
      .catch((error) => {
        if (
          ['futures', 'event-contract', 'bond', 'warrant', 'commodity', 'cfd'].includes(
            symbol.type ?? '',
          )
        )
          throw error
        const value = {
          supportedDurations: SUPPORTED_DURATIONS,
          priceStep: priceStepFromSymbol(symbol),
        }
        symbolRulesCache.set(path, {
          expiresAt: Date.now() + 15_000,
          value,
        })
        return value
      })
      .finally(() => symbolRulesInflight.delete(path))
    symbolRulesInflight.set(path, pending)
    return pending
  }

  const getTradingSymbolInfo = async (context: TradingOrderContext): Promise<TradingSymbolInfo> => {
    const isCrypto = context.symbol.type === 'crypto'
    const isForex = context.symbol.type === 'forex'
    const isOption = context.symbol.type === 'option'
    const isEvent = context.symbol.type === 'event-contract'
    const isNativeContract = ['bond', 'warrant', 'commodity', 'cfd'].includes(
      context.symbol.type ?? '',
    )
    const supportedOrderSides: TradingOrderDraft['side'][] | undefined = isEvent
      ? ['buy']
      : undefined
    const symbolRules: BrokerTradingSymbolRules = isAlpaca
      ? {
          supportedDurations: SUPPORTED_DURATIONS,
          priceStep: priceStepFromSymbol(context.symbol),
        }
      : await getBrokerSymbolRules(context.symbol)
    const contractOrderCodes: Record<string, string> = {
      market: 'MKT',
      limit: 'LMT',
      'market-to-limit': 'MTL',
      stop: 'STP',
      'stop-limit': 'STPLMT',
      'trailing-stop': 'TRAIL',
      'trailing-stop-limit': 'TRAILLMT',
      'market-on-close': 'MOC',
      'limit-on-close': 'LOC',
    }
    const availableCodes = new Set(symbolRules.orderTypes?.split(','))
    const contractRules = providerOrderRules.filter((rule) =>
      availableCodes.has(contractOrderCodes[rule.type] ?? ''),
    )
    if (
      (context.symbol.type === 'futures' || isNativeContract) &&
      ((context.symbol.type === 'futures' && !symbolRules.contractMultiplier) ||
        !symbolRules.minQuantity ||
        !symbolRules.quantityStep ||
        !symbolRules.priceStep ||
        !contractRules.length)
    ) {
      throw new Error(
        'IBKR contract sizing or order rules are unavailable. Resolve the exact contract again.',
      )
    }
    const supportsIceberg =
      !isAlpaca && supportsIbkrIceberg(context.symbol, symbolRules.defaultRoutingDestination)
    const referencePrice = context.lastPrice ?? context.bid ?? context.ask
    const routePriceStep = priceIncrementAt(symbolRules.priceIncrements, referencePrice)
    return withoutUndefined<TradingSymbolInfo>({
      symbol: context.symbol,
      accountId: context.accountId,
      currency: isNativeContract
        ? context.symbol.currency
        : (context.symbol.currency ?? context.currency),
      minQuantity: symbolRules.minQuantity ?? (isCrypto ? 0.00000001 : undefined),
      quantityStep: symbolRules.quantityStep ?? (isCrypto ? 0.00000001 : undefined),
      priceStep: routePriceStep ?? symbolRules.priceStep ?? (isForex ? 0.0001 : undefined),
      pipValue: isForex ? 0.0001 : undefined,
      contractMultiplier:
        symbolRules.contractMultiplier ?? (isOption || isNativeContract ? undefined : 1),
      ...(supportedOrderSides ? { supportedOrderSides } : {}),
      supportedOrderTypes: isEvent
        ? ['limit']
        : isOption
          ? [...OPTION_ORDER_TYPES]
          : isCrypto
            ? CRYPTO_ORDER_RULES.map((rule) => rule.type)
            : context.symbol.type === 'futures' || isNativeContract
              ? contractRules.map((rule) => rule.type)
              : [...providerOrderTypes],
      supportedOrderRules: isEvent
        ? [{ type: 'limit', label: 'LMT', requiresLimitPrice: true }]
        : isOption
          ? [...OPTION_ORDER_RULES]
          : isCrypto
            ? [...CRYPTO_ORDER_RULES]
            : context.symbol.type === 'futures' || isNativeContract
              ? contractRules
              : [...providerOrderRules],
      supportedDurations: isEvent
        ? [
            { type: 'day', label: 'DAY' },
            { type: 'gtc', label: 'GTC' },
            { type: 'ioc', label: 'IOC' },
          ]
        : isCrypto
          ? [...CRYPTO_DURATIONS]
          : symbolRules.supportedDurations,
      cashQuantity: isCrypto
        ? {
            supportedSides: ['buy'],
            supportedOrderTypes: ['market'],
            minAmount: 1,
            amountStep: 0.01,
            quickAmounts: [10, 25, 50, 100],
          }
        : undefined,
      routingDestinations: symbolRules.routingDestinations,
      defaultRoutingDestination: symbolRules.defaultRoutingDestination,
      allOrNone: symbolRules.allOrNone,
      oca: symbolRules.oca,
      supportsPostOnly: false,
      supportsMarketBrackets: !isOption && !isEvent,
      supportsMultipleExitLevels: !isOption && !isEvent && !isAlpaca,
      supportsUnpairedExitLevels: !isOption && !isEvent,
      supportsStopLoss: !isOption && !isEvent,
      supportsTrailingStop: !isOption && !isEvent,
      supportsGuaranteedStop: false,
      supportsHidden: false,
      orderTicketSettings: supportsIceberg ? IBKR_ICEBERG_TICKET_SETTINGS : undefined,
      orderTicketCustomFields: [...providerCustomFields],
      supportsShortSelling: !isAlpaca && !isCrypto && !isEvent,
      marginable: !isCrypto,
    })
  }

  const ensureEventSource = () => {
    if (eventSource) return
    const source = new EventSource(`${baseUrl}/events`)
    const handleMessage = (event: MessageEvent<string>) => {
      const backendEvent = JSON.parse(event.data) as BackendEvent
      const tradingEvent = toTradingEvent(backendEvent, providerName, executionEnvironment)
      if (!tradingEvent) return
      if (tradingEvent.type === 'state') lastState = tradingEvent.state
      if (tradingEvent.type === 'accounts' && lastState) {
        lastState = withoutUndefined<TradingState>({
          ...lastState,
          accounts: tradingEvent.accounts,
          activeAccountId: tradingEvent.activeAccountId ?? lastState.activeAccountId,
        })
      }
      emit(tradingEvent)
      publishAccountValues()
    }
    source.onopen = () => {
      request<BackendState>(baseUrl, '/state')
        .then((state) => {
          lastState = toTradingState(state, providerName, executionEnvironment)
          emit({ type: 'state', state: lastState })
        })
        .catch((error) => {
          emit({
            type: 'message',
            message: {
              type: 'warning',
              text:
                error instanceof Error
                  ? error.message
                  : `${providerName} bridge state refresh failed after SSE reconnect.`,
              time: Date.now(),
            },
          })
        })
    }
    source.addEventListener('state', handleMessage)
    source.addEventListener('connection-status', handleMessage)
    source.addEventListener('accounts', handleMessage)
    source.addEventListener('orders', handleMessage)
    source.addEventListener('orders-history', handleMessage)
    source.addEventListener('positions', handleMessage)
    source.addEventListener('executions', handleMessage)
    source.addEventListener('quotes', handleMessage)
    source.addEventListener('message', handleMessage)
    source.addEventListener('diagnostic', handleMessage)
    source.onerror = () => {
      emit({
        type: 'message',
        message: {
          type: 'warning',
          text: `${providerName} bridge SSE disconnected; browser will retry.`,
          time: Date.now(),
        },
      })
    }
    eventSource = source
  }

  const adapter: IbkrHttpBrokerAdapter = {
    ...(executionEnvironment === undefined ? {} : { executionEnvironment }),

    async connect(nextHost) {
      const health = captureHealth(await request<BackendHealth>(baseUrl, '/health'))
      lastState = toTradingState(
        await request<BackendState>(baseUrl, '/state'),
        providerName,
        executionEnvironment,
      )
      nextHost.setState(lastState)
      if (subscribers.size > 0) ensureEventSource()
      return {
        status: health.connectionStatus,
        connectionType: 'streaming',
        message: isAlpaca
          ? `${health.mode} Alpaca Paper`
          : `${health.mode} ${health.ibkrHost}:${health.ibkrPort}`,
      }
    },

    async disconnect() {
      eventSource?.close()
      eventSource = null
    },

    async getConnectionStatus() {
      return captureHealth(await request<BackendHealth>(baseUrl, '/health')).connectionStatus
    },

    async getHealth() {
      return captureHealth(await request<BackendHealth>(baseUrl, '/health'))
    },

    async getState() {
      lastState = toTradingState(
        await request<BackendState>(baseUrl, '/state'),
        providerName,
        executionEnvironment,
      )
      return lastState
    },

    subscribe(callback) {
      subscribers.add(callback)
      ensureEventSource()
      return () => {
        subscribers.delete(callback)
        if (subscribers.size === 0) {
          eventSource?.close()
          eventSource = null
        }
      }
    },

    async listAccounts() {
      return (await this.getState()).accounts
    },

    async setActiveAccount(accountId: string) {
      await userFacingRequest(() =>
        request(baseUrl, `/accounts/${encodeURIComponent(accountId)}/activate`, {
          method: 'POST',
          body: environmentBoundBody({}),
        }),
      )
      lastState = await this.getState()
      emit(
        withoutUndefined<TradingEvent>({
          type: 'accounts',
          accounts: lastState.accounts,
          activeAccountId: lastState.activeAccountId,
        }),
      )
      publishAccountValues()
    },

    getOrderTicketSettings(request: TradingTicketSettingsRequest): TradingTicketUserSettings {
      return readOrderTicketSettings(request)
    },

    async setOrderTicketSettings(
      settings: TradingTicketUserSettings,
      request: TradingTicketSettingsRequest,
    ) {
      writeOrderTicketSettings(request, { ...readOrderTicketSettings(request), ...settings })
    },

    getSuggestedQuantity(request: TradingSuggestedQuantityRequest) {
      return readSuggestedQuantity(request)
    },

    setSuggestedQuantity(quantity: number, request: TradingSuggestedQuantityRequest) {
      writeSuggestedQuantity(request, quantity)
      const key = suggestedQuantityKey(request)
      for (const subscriber of suggestedQuantitySubscribers) {
        if (suggestedQuantityKey(subscriber.request) === key) subscriber.callback(quantity)
      }
    },

    subscribeSuggestedQuantity(
      request: TradingSuggestedQuantityRequest,
      callback: (quantity: number | undefined) => void,
    ) {
      const subscriber = { request, callback }
      suggestedQuantitySubscribers.add(subscriber)
      callback(readSuggestedQuantity(request))
      return () => suggestedQuantitySubscribers.delete(subscriber)
    },

    subscribeEquity(request: TradingEquityRequest, callback: (equity: number | undefined) => void) {
      const subscriber = { request, callback }
      equitySubscribers.add(subscriber)
      if (lastState) publishEquity()
      else void this.getState().then(() => publishEquity())
      return () => equitySubscribers.delete(subscriber)
    },

    subscribeMarginAvailable(
      request: TradingMarginAvailableRequest,
      callback: (marginAvailable: number | undefined) => void,
    ) {
      const subscriber = { request, callback }
      marginSubscribers.add(subscriber)
      if (lastState) publishMarginAvailable()
      else void this.getState().then(() => publishMarginAvailable())
      return () => marginSubscribers.delete(subscriber)
    },

    subscribePipValue(
      request: TradingPipValueRequest,
      callback: (pipValue: number | undefined) => void,
    ) {
      callback(request.symbol.type === 'forex' ? 0.0001 : undefined)
      return () => undefined
    },

    async isTradable(context: TradingOrderContext) {
      if (isAlpaca && context.symbol.type !== 'stock') {
        return {
          tradable: false,
          reason: 'The Alpaca Paper widget backend currently supports US equities only.',
        }
      }
      if (
        !isAlpaca &&
        context.symbol.type &&
        context.symbol.type !== 'stock' &&
        context.symbol.type !== 'crypto' &&
        context.symbol.type !== 'forex' &&
        context.symbol.type !== 'futures' &&
        context.symbol.type !== 'bond' &&
        context.symbol.type !== 'warrant' &&
        context.symbol.type !== 'commodity' &&
        context.symbol.type !== 'cfd' &&
        context.symbol.type !== 'event-contract' &&
        context.symbol.type !== 'option'
      ) {
        return {
          tradable: false,
          reason:
            context.symbol.type === 'index'
              ? 'Cash indices are reference data. Select an index option or future to trade.'
              : context.symbol.type === 'fund'
                ? 'IBKR does not support mutual fund trading in paper accounts.'
                : 'This instrument type is not enabled for trading.',
        }
      }
      if (
        ['bond', 'warrant', 'commodity', 'cfd'].includes(context.symbol.type ?? '') &&
        !context.symbol.currency
      )
        return {
          tradable: false,
          reason:
            'IBKR has not supplied the contract currency. Trading is unavailable until contract metadata is complete.',
        }
      const brokerSymbol = context.symbol.brokerSymbol ?? context.symbol.ticker
      if (brokerSymbol.trim().length === 0) {
        return { tradable: false, reason: `A ${providerName} broker symbol is required.` }
      }
      const symbolInfo = await getTradingSymbolInfo(context)
      return withoutUndefined<TradingTradableResult>({
        tradable: true,
        symbolRules: {
          minQuantity: symbolInfo.minQuantity,
          maxQuantity: symbolInfo.maxQuantity,
          quantityStep: symbolInfo.quantityStep,
          minNotional: symbolInfo.minNotional,
          priceStep: symbolInfo.priceStep,
          pipValue: symbolInfo.pipValue,
          contractMultiplier: symbolInfo.contractMultiplier,
          supportedOrderTypes: symbolInfo.supportedOrderTypes,
          supportedOrderRules: symbolInfo.supportedOrderRules,
          supportedDurations: symbolInfo.supportedDurations,
          routingDestinations: symbolInfo.routingDestinations,
          defaultRoutingDestination: symbolInfo.defaultRoutingDestination,
          allOrNone: symbolInfo.allOrNone,
          oca: symbolInfo.oca,
          supportsPostOnly: false,
          supportsMarketBrackets: symbolInfo.supportsMarketBrackets,
          supportsMultipleExitLevels: symbolInfo.supportsMultipleExitLevels && !isAlpaca,
          supportsUnpairedExitLevels: symbolInfo.supportsUnpairedExitLevels,
          supportsStopLoss: symbolInfo.supportsStopLoss,
          supportsTrailingStop: symbolInfo.supportsTrailingStop,
          supportsGuaranteedStop: symbolInfo.supportsGuaranteedStop,
          supportsHidden: false,
          orderTicketSettings: symbolInfo.orderTicketSettings,
          orderTicketCustomFields: [...providerCustomFields],
          supportsShortSelling: symbolInfo.supportsShortSelling,
          marginable: symbolInfo.marginable,
        },
      })
    },

    getTradingSymbolInfo,

    async resolveOptionContract({
      contract,
      accountId,
    }: TradingResolveOptionContractRequest): Promise<TradingOptionContractResolution> {
      const resolution = await request<BackendOptionContractResolution>(
        baseUrl,
        '/options/resolve',
        {
          method: 'POST',
          body: environmentBoundBody({ contract: toBackendOptionContract(contract), accountId }),
        },
      )
      return withoutUndefined<TradingOptionContractResolution>({
        tradable: resolution.tradable,
        reason: resolution.reason,
        contract: toTradingOptionContract(resolution.contract),
      })
    },

    async getOrdersHistory(_request?: TradingOrdersHistoryRequest): Promise<TradingOrder[]> {
      return (await this.getState()).ordersHistory ?? []
    },

    getAccountManagerInfo() {
      const defaults = options.createDefaultAccountManagerInfo?.() ?? { pages: [] }
      return withIbkrAccountManagerPages(defaults)
    },

    async getAccountManagerTableRows(request: TradingAccountManagerTableDataRequest) {
      const state = await this.getState()
      return ibkrAccountManagerRows(state, request)
    },

    subscribeAccountManagerTableRows(
      request: TradingAccountManagerTableDataRequest,
      callback: (rows: unknown[]) => void,
    ) {
      let disposed = false
      const listener = (event: TradingEvent) => {
        if (event.type !== 'state' && event.type !== 'accounts' && event.type !== 'positions')
          return
        void this.getAccountManagerTableRows?.(request).then((rows) => {
          if (!disposed) callback(rows)
        })
      }
      subscribers.add(listener)
      return () => {
        disposed = true
        subscribers.delete(listener)
      }
    },

    async previewOrder(
      draft: TradingOrderDraft,
      context: TradingOrderContext,
    ): Promise<TradingOrderPreviewResult> {
      const result = await userFacingRequest(() =>
        request<BackendOrderPreviewResult>(baseUrl, '/orders/preview', {
          method: 'POST',
          body: environmentBoundBody({ draft: toBackendDraft(draft, context), context }),
        }),
      )
      return toOrderPreviewResult(result)
    },

    async previewModifyOrder(
      orderId: string,
      patch: TradingOrderPatch,
      context: TradingOrderContext,
    ): Promise<TradingOrderPreviewResult> {
      const result = await userFacingRequest(() =>
        request<BackendOrderPreviewResult>(
          baseUrl,
          `/orders/${encodeURIComponent(orderId)}/preview`,
          {
            method: 'POST',
            body: environmentBoundBody({ patch: toBackendPatch(patch), context }),
          },
        ),
      )
      return toOrderPreviewResult(result)
    },

    async placeOrder(
      draft: TradingOrderDraft,
      context: TradingOrderContext,
      financialOptions,
    ): Promise<TradingPlaceOrderResult> {
      const result = await userFacingRequest(() =>
        request<BackendPlaceOrderResult>(baseUrl, '/orders', {
          method: 'POST',
          body: environmentBoundBody({
            draft: toBackendDraft(draft, context),
            context,
            ...(financialOptions ? { metadata: financialOptions } : {}),
          }),
        }),
      )
      const order = toTradingOrder(result.order)
      return {
        accepted: true,
        status: 'submitted',
        order,
        message:
          order.message ??
          `Order sent to ${providerEnvironmentLabel(providerName, executionEnvironment)}. Follow the order status for updates.`,
      }
    },

    async modifyOrder(
      orderId: string,
      patch: TradingOrderPatch,
      context: TradingOrderContext,
      financialOptions,
    ): Promise<TradingOrder> {
      const backendPatch = toBackendPatch(patch)
      const result = await userFacingRequest(() =>
        request<BackendPlaceOrderResult>(baseUrl, `/orders/${encodeURIComponent(orderId)}`, {
          method: 'PATCH',
          body: environmentBoundBody({
            patch: backendPatch,
            context,
            ...(financialOptions ? { metadata: financialOptions } : {}),
          }),
        }),
      )
      return toTradingOrder(result.order)
    },

    async cancelOrder(orderId: string, _context, financialOptions) {
      await userFacingRequest(() =>
        request(baseUrl, `/orders/${encodeURIComponent(orderId)}`, {
          method: 'DELETE',
          body: environmentBoundBody({
            ...(financialOptions ? { metadata: financialOptions } : {}),
          }),
        }),
      )
    },

    async cancelOrders(orderIds: string[], _context, financialOptions) {
      await Promise.all(
        orderIds.map((orderId) =>
          userFacingRequest(() =>
            request(baseUrl, `/orders/${encodeURIComponent(orderId)}`, {
              method: 'DELETE',
              body: environmentBoundBody({
                ...(financialOptions ? { metadata: financialOptions } : {}),
              }),
            }),
          ),
        ),
      )
    },

    async previewClosePosition(
      positionId: string,
      context: TradingOrderContext,
    ): Promise<TradingPositionPreviewResult> {
      const result = await userFacingRequest(() =>
        request<BackendOrderPreviewResult>(
          baseUrl,
          `/positions/${encodeURIComponent(positionId)}/close/preview`,
          {
            method: 'POST',
            body: environmentBoundBody({ context }),
          },
        ),
      )
      const preview = toOrderPreviewResult(result)
      return withoutUndefined<TradingPositionPreviewResult>({
        accepted: preview.accepted,
        message: preview.message,
        sections: preview.sections,
      })
    },

    async closePosition(
      positionId: string,
      context: TradingOrderContext,
      options?: TradingPositionCloseOptions,
    ): Promise<void> {
      await userFacingRequest(() =>
        request(baseUrl, `/positions/${encodeURIComponent(positionId)}/close`, {
          method: 'POST',
          body: environmentBoundBody({ context, options }),
        }),
      )
    },

    getFeatures() {
      return {
        supportsOrders: true,
        supportsPositions: true,
        supportsExecutions: true,
        supportsOrderPreview: true,
        supportsModifyOrderPreview: true,
        supportsBrackets: true,
        supportsNativeStopLimit: true,
        supportsAccountPanel: true,
      }
    },
  }
  return adapter
}

function priceIncrementAt(
  bands: Array<{ lowEdge: number; increment: number }> | undefined,
  price: number | undefined,
): number | undefined {
  if (!bands?.length) return undefined
  const finitePrice = price !== undefined && Number.isFinite(price) ? price : 0
  return bands
    .filter((band) => band.lowEdge <= finitePrice && band.increment > 0)
    .sort((left, right) => right.lowEdge - left.lowEdge)[0]?.increment
}
