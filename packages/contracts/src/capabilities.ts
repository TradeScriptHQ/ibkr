export const TRADESCRIPT_SDK_PRODUCTS = [
  'chart',
  'mobileChart',
  'marketData',
  'sessions',
  'symbols',
  'symbolSearch',
  'agentConsole',
  'sessionMeta',
  'marketDepth',
  'timeAndSales',
  'workspaceTabs',
  'chartDataTable',
  'chartDataTableModal',
  'accountPanel',
  'accountActionDialog',
  'accountSummary',
  'orderTicket',
  'orderTicketLauncher',
  'optionOrderTicket',
  'predictionMarketOrderTicket',
  'optionChain',
  'ladder',
  'watchlist',
  'layout',
  'tradingTerminal',
  'trading',
] as const

export type TradeScriptSdkProduct = (typeof TRADESCRIPT_SDK_PRODUCTS)[number]

export const TRADING_CONTROLLER_OPERATION_IDS = [
  'getOperationSupport',
  'getExecutionEnvironment',
  'connect',
  'disconnect',
  'getConnectionStatus',
  'getFeatures',
  'getState',
  'subscribe',
  'getAccountManagerInfo',
  'getAccountManagerTableRows',
  'subscribeAccountManagerTableRows',
  'getAccountManagerTablePage',
  'subscribeAccountManagerTableUpdates',
  'executeAccountManagerAction',
  'listAccounts',
  'setActiveAccount',
  'isTradable',
  'getTradingSymbolInfo',
  'resolveOptionContract',
  'getOrdersHistory',
  'getOrderTicketSettings',
  'setOrderTicketSettings',
  'getSuggestedQuantity',
  'setSuggestedQuantity',
  'subscribeSuggestedQuantity',
  'subscribeEquity',
  'subscribeMarginAvailable',
  'subscribePipValue',
  'leverageInfo',
  'previewLeverage',
  'setLeverage',
  'previewOrder',
  'previewModifyOrder',
  'placeOrder',
  'modifyOrder',
  'cancelOrder',
  'cancelOrders',
  'cancelAllOrders',
  'supportsOrderCancellation',
  'supportsOrderModification',
  'previewClosePosition',
  'modifyPosition',
  'closePosition',
  'closeIndividualPosition',
  'reversePosition',
  'flattenPositions',
  'editIndividualPositionBrackets',
  'getLogs',
  'clearLogs',
  'getOrderDraft',
  'openOrderDraft',
  'updateOrderDraft',
  'clearOrderDraft',
  'submitOrderDraft',
] as const

export type TradingControllerOperationId = (typeof TRADING_CONTROLLER_OPERATION_IDS)[number]

export const MARKET_DATA_CAPABILITY_FAMILIES = [
  'readiness',
  'configuration',
  'symbol-search',
  'symbol-resolution',
  'history',
  'realtime-bars',
  'server-time',
  'marks',
  'timescale-marks',
  'semantic-events',
  'volume-profile-resolution',
  'quotes',
  'market-depth',
  'time-and-sales',
  'external-series',
  'book-history',
  'sessions',
  'news',
  'instrument-details',
  'watchlists',
  'data-window',
  'option-contracts',
  'option-quotes',
] as const

export type MarketDataCapabilityFamily = (typeof MARKET_DATA_CAPABILITY_FAMILIES)[number]

export type CapabilityDisposition =
  | 'pending-sdk'
  | 'not-implemented'
  | 'implemented'
  | 'entitlement-denied'
  | 'ibkr-unsupported'
  | 'not-applicable'

export interface CapabilityEntry<Id extends string> {
  readonly id: Id
  readonly disposition: CapabilityDisposition
  readonly reason?: string
}

const NOT_APPLICABLE_PRODUCTS = new Map<TradeScriptSdkProduct, string>([
  ['mobileChart', 'The first release is a desktop workstation.'],
  ['predictionMarketOrderTicket', 'IBKR/TWS is not a prediction-market adapter.'],
])

export const BASELINE_PRODUCT_CAPABILITIES: readonly CapabilityEntry<TradeScriptSdkProduct>[] =
  TRADESCRIPT_SDK_PRODUCTS.map((id) => {
    const reason = NOT_APPLICABLE_PRODUCTS.get(id)
    return reason === undefined
      ? { id, disposition: 'pending-sdk' as const }
      : { id, disposition: 'not-applicable' as const, reason }
  })

const UNSUPPORTED_TRADING_CAPABILITIES = new Map<
  TradingControllerOperationId,
  Omit<CapabilityEntry<TradingControllerOperationId>, 'id'>
>([
  [
    'getAccountManagerTablePage',
    {
      disposition: 'not-applicable',
      reason: 'The IBKR Account Manager uses complete snapshot tables, not cursor pagination.',
    },
  ],
  [
    'subscribeAccountManagerTableUpdates',
    {
      disposition: 'not-applicable',
      reason: 'The IBKR Account Manager publishes complete snapshot replacements.',
    },
  ],
  [
    'executeAccountManagerAction',
    {
      disposition: 'not-applicable',
      reason: 'No adapter-defined Account Manager row actions are exposed.',
    },
  ],
  [
    'leverageInfo',
    {
      disposition: 'ibkr-unsupported',
      reason: 'TWS does not expose per-order leverage selection through this broker contract.',
    },
  ],
  [
    'previewLeverage',
    {
      disposition: 'ibkr-unsupported',
      reason: 'TWS does not expose per-order leverage selection through this broker contract.',
    },
  ],
  [
    'setLeverage',
    {
      disposition: 'ibkr-unsupported',
      reason: 'TWS does not expose per-order leverage selection through this broker contract.',
    },
  ],
  [
    'cancelAllOrders',
    {
      disposition: 'ibkr-unsupported',
      reason: 'TWS global cancel cannot preserve the SDK account and symbol scope contract.',
    },
  ],
  [
    'modifyPosition',
    {
      disposition: 'not-implemented',
      reason: 'Net-position bracket reconciliation is not implemented in the V1 gateway.',
    },
  ],
  [
    'closeIndividualPosition',
    {
      disposition: 'not-applicable',
      reason: 'The IBKR adapter exposes broker-netted positions, not individual positions.',
    },
  ],
  [
    'reversePosition',
    {
      disposition: 'not-implemented',
      reason: 'Position reversal is not implemented in the V1 gateway.',
    },
  ],
  [
    'flattenPositions',
    {
      disposition: 'ibkr-unsupported',
      reason: 'TWS cannot provide the SDK broker-atomic scoped flatten contract.',
    },
  ],
  [
    'editIndividualPositionBrackets',
    {
      disposition: 'not-applicable',
      reason: 'The IBKR adapter exposes broker-netted positions, not individual positions.',
    },
  ],
])

export const BASELINE_TRADING_CAPABILITIES: readonly CapabilityEntry<TradingControllerOperationId>[] =
  TRADING_CONTROLLER_OPERATION_IDS.map((id) => ({
    id,
    ...(UNSUPPORTED_TRADING_CAPABILITIES.get(id) ?? { disposition: 'implemented' as const }),
  }))

export const BASELINE_MARKET_DATA_CAPABILITIES: readonly CapabilityEntry<MarketDataCapabilityFamily>[] =
  MARKET_DATA_CAPABILITY_FAMILIES.map((id) => ({ id, disposition: 'pending-sdk' as const }))
