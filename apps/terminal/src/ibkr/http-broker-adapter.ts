import type { BrokerAccountCurrencyConversion } from '@ibkr-terminal/contracts'
import type {
  SymbolInfo,
  TradingAccountManagerInfo,
  TradingAccountManagerTableDataRequest,
  TradingBrokerAdapter,
  TradingEquityRequest,
  TradingEvent,
  TradingExecutionEnvironment,
  TradingFinancialMutationOptions,
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
  TradingPreviewSection,
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
import { GatewayRequestError, gatewayRequest } from './broker-request.js'
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
  pipSize?: number | undefined
  monetaryValueAvailable?: boolean | undefined
  monetaryValueUnavailableReason?: string | undefined
  priceIncrements?: Array<{ lowEdge: number; increment: number }> | undefined
  routingDestination?: string | undefined
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

const CANCEL_ACK_TIMEOUT_MS = 10_000
const CANCEL_ACK_POLL_MS = 250

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
  const currencyConversionInflight = new Map<
    string,
    Promise<TradingSymbolInfo['accountCurrencyConversion']>
  >()
  let eventSource: EventSource | null = null
  let eventSourceCleanup: (() => void) | undefined
  let lastState: TradingState | null = null
  let stateRevision = 0
  let stateGeneration = 0
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

  const getBrokerSymbolRules = async (
    symbol: SymbolInfo,
    routingDestination?: string,
  ): Promise<BrokerTradingSymbolRules> => {
    const path = brokerSessionPath(symbol, routingDestination)
    const cached = symbolRulesCache.get(path)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const existing = symbolRulesInflight.get(path)
    if (existing) return existing
    const pending = request<{
      symbol?:
        | {
            minTick?: number | undefined
            exchange?: string | undefined
            pipDefinition?: { pipSize: number } | undefined
            priceIncrements?: Array<{ lowEdge: number; increment: number }> | undefined
          }
        | undefined
      metadata?:
        | {
            minQuantity?: number | undefined
            orderTypes?: string | undefined
            quantityStep?: number | undefined
            contractMultiplier?: number | undefined
            monetaryValueAvailable?: boolean | undefined
            monetaryValueUnavailableReason?: string | undefined
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
        const priceIncrements = authoritativePriceIncrements(session.symbol?.priceIncrements)
        const ruleRoute = routingDestination ?? symbol.exchange ?? session.symbol?.exchange
        const value = {
          orderTypes: session.metadata?.orderTypes,
          supportedDurations: brokerDurations?.length ? brokerDurations : SUPPORTED_DURATIONS,
          priceIncrements,
          routingDestination: priceIncrements ? ruleRoute?.trim().toUpperCase() : undefined,
          pipSize: positiveStep(session.symbol?.pipDefinition?.pipSize),
          minQuantity: positiveStep(session.metadata?.minQuantity),
          quantityStep: positiveStep(session.metadata?.quantityStep),
          contractMultiplier: positiveStep(session.metadata?.contractMultiplier),
          monetaryValueAvailable: session.metadata?.monetaryValueAvailable,
          monetaryValueUnavailableReason: session.metadata?.monetaryValueUnavailableReason,
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
          monetaryValueAvailable: false,
          monetaryValueUnavailableReason:
            'IBKR contract monetary units are unavailable because exact provider metadata could not be loaded.',
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

  const getAccountCurrencyConversion = async (
    context: TradingOrderContext,
  ): Promise<TradingSymbolInfo['accountCurrencyConversion']> => {
    if (isAlpaca || !context.accountId || !context.symbol.currency) return undefined
    const requestGeneration = stateGeneration
    const state = lastState ?? (await readState())
    const toCurrency = state.accounts
      .find((account) => account.id === context.accountId)
      ?.currency?.trim()
      .toUpperCase()
    const fromCurrency = context.symbol.currency.trim().toUpperCase()
    if (!toCurrency || fromCurrency === toCurrency) return undefined
    const path = `/accounts/${encodeURIComponent(context.accountId)}/currency-conversion?${new URLSearchParams({ fromCurrency })}`
    const lookupKey = `${requestGeneration}:${toCurrency}:${path}`
    const pending = currencyConversionInflight.get(lookupKey)
    if (pending) return pending
    const lookup = request<BrokerAccountCurrencyConversion>(baseUrl, path)
      .then((conversion) => {
        if (
          requestGeneration !== stateGeneration ||
          lastState?.accounts
            .find((account) => account.id === context.accountId)
            ?.currency?.trim()
            .toUpperCase() !== toCurrency
        )
          throw new Error('Broker connection or account currency changed during conversion lookup.')
        const now = Date.now()
        if (
          conversion.fromCurrency !== fromCurrency ||
          conversion.toCurrency !== toCurrency ||
          !Number.isFinite(conversion.rate) ||
          conversion.rate <= 0 ||
          !Number.isFinite(conversion.asOf) ||
          conversion.asOf > now ||
          now - conversion.asOf > 15_000 ||
          !conversion.source?.startsWith('ibkr-live-fx:')
        )
          throw new Error(
            'Broker returned inconsistent or stale account currency conversion facts.',
          )
        return conversion
      })
      .catch((error) => {
        // Conversion is optional metadata; absence still rejects monetary risk evaluation.
        if (error instanceof GatewayRequestError && [404, 503, 504].includes(error.status))
          return undefined
        throw error
      })
      .finally(() => currencyConversionInflight.delete(lookupKey))
    currencyConversionInflight.set(lookupKey, lookup)
    return lookup
  }

  const getTradingSymbolInfo = async (context: TradingOrderContext): Promise<TradingSymbolInfo> => {
    const isCrypto = context.symbol.type === 'crypto'
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
      : await getBrokerSymbolRules(
          context.symbol,
          'routingDestination' in context && typeof context.routingDestination === 'string'
            ? context.routingDestination
            : undefined,
        )
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
        (!symbolRules.priceStep && !symbolRules.priceIncrements) ||
        !contractRules.length)
    ) {
      throw new Error(
        'IBKR contract sizing or order rules are unavailable. Resolve the exact contract again.',
      )
    }
    const supportsIceberg =
      !isAlpaca && supportsIbkrIceberg(context.symbol, symbolRules.defaultRoutingDestination)
    const priceRules = withoutUndefined({
      priceStep: symbolRules.priceStep,
      priceIncrements: symbolRules.priceIncrements,
      routingDestination: symbolRules.routingDestination,
      monetaryValueAvailable: symbolRules.monetaryValueAvailable,
      monetaryValueUnavailableReason: symbolRules.monetaryValueUnavailableReason,
    })
    const accountCurrencyConversion = await getAccountCurrencyConversion(context)
    return withoutUndefined<TradingSymbolInfo>({
      symbol: context.symbol,
      accountId: context.accountId,
      currency: isNativeContract
        ? context.symbol.currency
        : (context.symbol.currency ?? context.currency),
      minQuantity: symbolRules.minQuantity ?? (isCrypto ? 0.00000001 : undefined),
      quantityStep: symbolRules.quantityStep ?? (isCrypto ? 0.00000001 : undefined),
      ...priceRules,
      pipSize: symbolRules.pipSize,
      contractMultiplier:
        symbolRules.contractMultiplier ?? (isOption || isNativeContract ? undefined : 1),
      accountCurrencyConversion,
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
      // Pip distance is provider/catalog authority, independent of ticks and monetary pip value.
      supportsTrailingStop: !isOption && !isEvent && !isAlpaca && symbolRules.pipSize !== undefined,
      supportsGuaranteedStop: false,
      supportsHidden: false,
      orderTicketSettings: supportsIceberg ? IBKR_ICEBERG_TICKET_SETTINGS : undefined,
      orderTicketCustomFields: [...providerCustomFields],
      supportsShortSelling: !isAlpaca && !isCrypto && !isEvent,
      marginable: !isCrypto,
    })
  }

  const closeEventSource = () => {
    stateGeneration += 1
    eventSourceCleanup?.()
    eventSourceCleanup = undefined
    eventSource?.close()
    eventSource = null
  }

  const ensureEventSource = () => {
    if (eventSource) return
    const source = new EventSource(`${baseUrl}/events`)
    let openRevision = 0
    let refreshing = false
    let refreshRequested = false
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 250
    const isCurrent = () => eventSource === source
    const handleMessage = (event: MessageEvent<string>) => {
      if (!isCurrent()) return
      const backendEvent = JSON.parse(event.data) as BackendEvent
      const tradingEvent = toTradingEvent(backendEvent, providerName, executionEnvironment)
      if (!tradingEvent) return
      if (
        [
          'state',
          'accounts',
          'orders',
          'orders-history',
          'positions',
          'executions',
          'connection-status',
        ].includes(tradingEvent.type)
      )
        stateRevision += 1
      if (tradingEvent.type === 'state') lastState = tradingEvent.state
      if (tradingEvent.type === 'accounts' && lastState) {
        lastState = withoutUndefined<TradingState>({
          ...lastState,
          accounts: tradingEvent.accounts,
          activeAccountId: tradingEvent.activeAccountId ?? lastState.activeAccountId,
        })
      }
      if (lastState) {
        if (tradingEvent.type === 'orders')
          lastState = { ...lastState, orders: tradingEvent.orders }
        if (tradingEvent.type === 'orders-history')
          lastState = { ...lastState, ordersHistory: tradingEvent.orders }
        if (tradingEvent.type === 'positions')
          lastState = { ...lastState, positions: tradingEvent.positions }
        if (tradingEvent.type === 'executions')
          lastState = { ...lastState, executions: tradingEvent.executions }
        if (tradingEvent.type === 'connection-status')
          lastState = { ...lastState, connectionStatus: tradingEvent.status }
      }
      emit(tradingEvent)
      publishAccountValues()
    }
    const refreshSnapshot = async () => {
      if (!isCurrent()) return
      if (refreshing) {
        refreshRequested = true
        return
      }
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshing = true
      refreshRequested = false
      const requestRevision = stateRevision
      const requestOpenRevision = openRevision
      try {
        const state = await request<BackendState>(baseUrl, '/state')
        if (!isCurrent()) return
        if (requestRevision !== stateRevision || requestOpenRevision !== openRevision) {
          refreshRequested = true
          return
        }
        stateRevision += 1
        retryDelay = 250
        lastState = toTradingState(state, providerName, executionEnvironment)
        emit({ type: 'state', state: lastState })
        publishAccountValues()
      } catch (error) {
        if (isCurrent()) {
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
        }
      } finally {
        refreshing = false
        if (isCurrent() && refreshRequested) {
          refreshTimer = setTimeout(() => void refreshSnapshot(), retryDelay)
          retryDelay = Math.min(4_000, retryDelay * 2)
        }
      }
    }
    source.onopen = () => {
      if (!isCurrent()) return
      stateGeneration += 1
      openRevision += 1
      void refreshSnapshot()
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
      if (!isCurrent()) return
      emit({
        type: 'message',
        message: {
          type: 'warning',
          text: `${providerName} bridge SSE disconnected; browser will retry.`,
          time: Date.now(),
        },
      })
    }
    eventSourceCleanup = () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      source.onopen = null
      source.onerror = null
    }
    eventSource = source
  }

  // SDK adapter callbacks may be extracted and invoked without a receiver. Own state access in
  // this closure so account, history and subscription callbacks do not depend on `this`.
  const readState = async (): Promise<TradingState> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestRevision = stateRevision
      const requestGeneration = stateGeneration
      const state = await request<BackendState>(baseUrl, '/state')
      if (requestGeneration !== stateGeneration) {
        throw new Error(
          'Broker connection changed during state refresh. Retry on the current connection.',
        )
      }
      if (requestRevision !== stateRevision) {
        if (lastState) return lastState
        continue
      }
      stateRevision += 1
      lastState = toTradingState(state, providerName, executionEnvironment)
      return lastState
    }
    throw new Error(
      'Broker state changed during refresh. Retry when a current snapshot is available.',
    )
  }
  const refreshFailed = (error: unknown) => {
    emit({
      type: 'message',
      message: {
        type: 'warning',
        text: error instanceof Error ? error.message : `${providerName} account refresh failed.`,
        time: Date.now(),
      },
    })
  }
  const accountManagerRows = async (tableRequest: TradingAccountManagerTableDataRequest) =>
    ibkrAccountManagerRows(await readState(), tableRequest)

  const waitForCancellation = async (orderId: string): Promise<void> => {
    const deadlineAt = Date.now() + CANCEL_ACK_TIMEOUT_MS
    const unknown = (detail: string) =>
      Object.assign(
        new Error(
          `Cancellation of ${orderId} is not confirmed: ${detail}. Reconcile broker state before retrying.`,
        ),
        { code: 'CANCEL_OUTCOME_UNKNOWN' },
      )
    while (Date.now() < deadlineAt) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let state: TradingState
      try {
        state = await Promise.race([
          readState(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(unknown('the acknowledgement deadline expired')),
              deadlineAt - Date.now(),
            )
          }),
        ])
      } catch (error) {
        throw unknown(error instanceof Error ? error.message : 'broker state is unavailable')
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      const order =
        state.orders.find((candidate) => candidate.id === orderId) ??
        state.ordersHistory?.find((candidate) => candidate.id === orderId)
      lastState = state
      emit({ type: 'state', state: lastState })
      if (order?.status === 'cancelled') return
      if (order?.status === 'filled' || order?.status === 'rejected') {
        throw Object.assign(
          new Error(
            `Cancellation of ${orderId} was not confirmed; the broker order is ${order.status}.`,
          ),
          {
            code: 'CANCEL_NOT_CONFIRMED',
          },
        )
      }
      if (state.connectionStatus !== 'connected')
        throw unknown('the broker connection is unavailable')
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(CANCEL_ACK_POLL_MS, Math.max(0, deadlineAt - Date.now()))),
      )
    }
    throw unknown('the acknowledgement deadline expired')
  }
  const cancelOrder = async (
    orderId: string,
    financialOptions?: TradingFinancialMutationOptions,
  ) => {
    await userFacingRequest(async () => {
      await request(baseUrl, `/orders/${encodeURIComponent(orderId)}`, {
        method: 'DELETE',
        body: environmentBoundBody({ ...(financialOptions ? { metadata: financialOptions } : {}) }),
      })
      await waitForCancellation(orderId)
    })
  }

  const adapter: IbkrHttpBrokerAdapter = {
    ...(executionEnvironment === undefined ? {} : { executionEnvironment }),

    async connect(nextHost) {
      const health = captureHealth(await request<BackendHealth>(baseUrl, '/health'))
      lastState = await readState()
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
      closeEventSource()
    },

    async getConnectionStatus() {
      return captureHealth(await request<BackendHealth>(baseUrl, '/health')).connectionStatus
    },

    async getHealth() {
      return captureHealth(await request<BackendHealth>(baseUrl, '/health'))
    },

    getState: readState,

    subscribe(callback) {
      subscribers.add(callback)
      ensureEventSource()
      return () => {
        subscribers.delete(callback)
        if (subscribers.size === 0) {
          closeEventSource()
        }
      }
    },

    async listAccounts() {
      return (await readState()).accounts
    },

    async setActiveAccount(accountId: string) {
      await userFacingRequest(() =>
        request(baseUrl, `/accounts/${encodeURIComponent(accountId)}/activate`, {
          method: 'POST',
          body: environmentBoundBody({}),
        }),
      )
      lastState = await readState()
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
      else
        void readState().then(publishEquity, (error) => {
          refreshFailed(error)
          if (equitySubscribers.has(subscriber)) callback(undefined)
        })
      return () => equitySubscribers.delete(subscriber)
    },

    subscribeMarginAvailable(
      request: TradingMarginAvailableRequest,
      callback: (marginAvailable: number | undefined) => void,
    ) {
      const subscriber = { request, callback }
      marginSubscribers.add(subscriber)
      if (lastState) publishMarginAvailable()
      else
        void readState().then(publishMarginAvailable, (error) => {
          refreshFailed(error)
          if (marginSubscribers.has(subscriber)) callback(undefined)
        })
      return () => marginSubscribers.delete(subscriber)
    },

    subscribePipValue(
      _request: TradingPipValueRequest,
      callback: (pipValue: number | undefined) => void,
    ) {
      // IBKR session metadata currently supplies price increments, not a monetary pip value.
      callback(undefined)
      return () => undefined
    },

    async isTradable(context: TradingOrderContext) {
      if (context.symbol.type === undefined) {
        return {
          tradable: false,
          reason:
            'The instrument type is unavailable or unsupported. Resolve a supported contract before trading.',
        }
      }
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
      return (await readState()).ordersHistory ?? []
    },

    getAccountManagerInfo() {
      const defaults = options.createDefaultAccountManagerInfo?.() ?? { pages: [] }
      return withIbkrAccountManagerPages(defaults)
    },

    getAccountManagerTableRows: accountManagerRows,

    subscribeAccountManagerTableRows(
      request: TradingAccountManagerTableDataRequest,
      callback: (rows: unknown[]) => void,
    ) {
      let disposed = false
      const listener = (event: TradingEvent) => {
        if (event.type !== 'state' && event.type !== 'accounts' && event.type !== 'positions')
          return
        void accountManagerRows(request).then((rows) => {
          if (!disposed) callback(rows)
        }, refreshFailed)
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
      await cancelOrder(orderId, financialOptions)
    },

    async cancelOrders(orderIds: string[], _context, financialOptions) {
      await Promise.all(orderIds.map((orderId) => cancelOrder(orderId, financialOptions)))
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
      const rows: TradingPreviewSection['rows'] = []
      const moneyValue = (amount: number, currency?: string) =>
        currency
          ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
          : `${amount} (currency unavailable)`
      if (preview.estimatedCommission !== undefined) {
        rows.push({
          label: 'Estimated commission',
          value: moneyValue(preview.estimatedCommission, preview.commissionCurrency),
        })
      } else if (preview.estimatedCommissionRange) {
        const { minimum, maximum } = preview.estimatedCommissionRange
        const value =
          minimum !== undefined && maximum !== undefined
            ? `${moneyValue(minimum, preview.commissionCurrency)} – ${moneyValue(maximum, preview.commissionCurrency)}`
            : minimum !== undefined
              ? `From ${moneyValue(minimum, preview.commissionCurrency)}`
              : maximum !== undefined
                ? `Up to ${moneyValue(maximum, preview.commissionCurrency)}`
                : undefined
        if (value) rows.push({ label: 'Estimated commission', value })
      }
      if (preview.estimatedFees !== undefined)
        rows.push({
          label: 'Estimated fees',
          value: moneyValue(preview.estimatedFees, preview.feesCurrency),
        })
      if (preview.estimatedMargin !== undefined)
        rows.push({
          label: 'Estimated margin',
          value: moneyValue(preview.estimatedMargin, preview.marginCurrency),
        })
      const messages = [preview.message, ...(preview.warnings ?? [])].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
      const sections = [...(preview.sections ?? []), ...(rows.length ? [{ rows }] : [])]
      return withoutUndefined<TradingPositionPreviewResult>({
        accepted: preview.accepted,
        message: messages.length ? messages.join('\n') : undefined,
        sections: sections.length ? sections : undefined,
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

function authoritativePriceIncrements(
  bands: Array<{ lowEdge: number; increment: number }> | undefined,
): Array<{ lowEdge: number; increment: number }> | undefined {
  if (!bands?.length) return undefined
  let previous = -Infinity
  for (const band of bands) {
    if (
      !Number.isFinite(band.lowEdge) ||
      band.lowEdge < 0 ||
      band.lowEdge <= previous ||
      !Number.isFinite(band.increment) ||
      band.increment <= 0
    )
      return undefined
    previous = band.lowEdge
  }
  return bands.map((band) => ({ ...band }))
}
