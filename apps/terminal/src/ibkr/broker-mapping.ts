import type {
  SymbolInfo,
  TradingAccount,
  TradingEvent,
  TradingExecutionEnvironment,
  TradingOptionContract,
  TradingOrder,
  TradingOrderPatch,
  TradingOrderPreviewResult,
  TradingPosition,
  TradingState,
} from '@tradescript/pro/sdk'
import {
  ALPACA_ORDER_RULES,
  IBKR_ORDER_TICKET_CUSTOM_FIELDS,
  SUPPORTED_DURATIONS,
  SUPPORTED_ORDER_RULES,
  SUPPORTED_ORDER_TYPES,
} from './broker-order-rules.js'
import { withoutUndefined } from './defined-fields.js'
import { orderTransmissionPresentation } from './order-transmission.js'
import type {
  BackendAccount,
  BackendEvent,
  BackendExecution,
  BackendOrder,
  BackendOrderPatch,
  BackendOrderPreviewResult,
  BackendPosition,
  BackendState,
  BackendSymbol,
} from './types'
import { toBackendDuration, toBackendOrderCustomFields, toTradingDuration } from './types'
import { toBackendOca } from './types.js'

export function toTradingState(
  state: BackendState,
  providerName: 'IBKR' | 'Alpaca',
  executionEnvironment: TradingExecutionEnvironment | undefined,
): TradingState {
  return withoutUndefined<TradingState>({
    connectionStatus: state.connectionStatus,
    activeAccountId: state.activeAccountId,
    accounts: state.accounts.map((account) =>
      toTradingAccount(account, state.activeAccountId, providerName, executionEnvironment),
    ),
    orders: state.orders.map(toTradingOrder),
    ordersHistory: state.ordersHistory?.map(toTradingOrder),
    positions: state.positions.map(toTradingPosition),
    executions: state.executions.map(toTradingExecution),
    messages: state.messages.map((message) => ({
      id: message.id,
      type: message.level,
      text: message.text,
      time: Date.parse(message.timestamp),
    })),
  })
}

export function toTradingEvent(
  event: BackendEvent,
  providerName: 'IBKR' | 'Alpaca',
  executionEnvironment: TradingExecutionEnvironment | undefined,
): TradingEvent | undefined {
  if (event.type === 'state')
    return withoutUndefined<TradingEvent | undefined>({
      type: 'state',
      state: toTradingState(event.state, providerName, executionEnvironment),
    })
  if (event.type === 'connection-status')
    return withoutUndefined<TradingEvent | undefined>({
      type: 'connection-status',
      status: event.status,
    })
  if (event.type === 'accounts')
    return withoutUndefined<TradingEvent | undefined>({
      type: 'accounts',
      accounts: event.accounts.map((account) =>
        toTradingAccount(account, event.activeAccountId, providerName, executionEnvironment),
      ),
      activeAccountId: event.activeAccountId,
    })
  if (event.type === 'orders')
    return withoutUndefined<TradingEvent | undefined>({
      type: 'orders',
      orders: event.orders.map(toTradingOrder),
    })
  if (event.type === 'orders-history')
    return withoutUndefined<TradingEvent | undefined>({
      type: 'orders-history',
      orders: event.orders.map(toTradingOrder),
    })
  if (event.type === 'positions')
    return withoutUndefined<TradingEvent | undefined>({
      type: 'positions',
      positions: event.positions.map(toTradingPosition),
    })
  if (event.type === 'executions')
    return withoutUndefined<TradingEvent | undefined>({
      type: 'executions',
      executions: event.executions.map(toTradingExecution),
    })
  if (event.type === 'quotes' || event.type === 'market-depth') return undefined
  if (event.type === 'diagnostic')
    return withoutUndefined<TradingEvent | undefined>({
      type: 'log',
      entry: {
        id: event.diagnostic.id,
        level: event.diagnostic.level,
        source: 'adapter',
        message: event.diagnostic.text,
        time: Date.parse(event.diagnostic.timestamp),
      },
    })
  return withoutUndefined<TradingEvent | undefined>({
    type: 'message',
    message: {
      id: event.message.id,
      type: event.message.level,
      text: event.message.text,
      time: Date.parse(event.message.timestamp),
    },
  })
}

function toTradingAccount(
  account: BackendAccount,
  activeAccountId: string | undefined,
  providerName: 'IBKR' | 'Alpaca',
  executionEnvironment: TradingExecutionEnvironment | undefined,
): TradingAccount {
  return withoutUndefined<TradingAccount>({
    id: account.id,
    name: account.label,
    brokerName: providerEnvironmentLabel(providerName, executionEnvironment),
    currency: account.currency,
    isActive: account.id === activeAccountId,
    balance: {
      cash: account.cash,
      buyingPower: account.buyingPower,
      equity: account.netLiquidation,
      marginUsed: account.marginUsed,
      maintenanceMargin: account.maintenanceMargin,
      currency: account.currency,
    },
    pnl: {
      totalPnl:
        account.realizedPnl !== undefined && account.unrealizedPnl !== undefined
          ? account.realizedPnl + account.unrealizedPnl
          : undefined,
      realizedPnl: account.realizedPnl,
      unrealizedPnl: account.unrealizedPnl,
      currency: account.currency,
    },
    capabilities: {
      supportsTrading: true,
      supportsMargin: account.availableFunds !== undefined || account.buyingPower !== undefined,
      supportedOrderTypes:
        providerName === 'Alpaca'
          ? ALPACA_ORDER_RULES.map((rule) => rule.type)
          : [...SUPPORTED_ORDER_TYPES],
      supportedOrderRules:
        providerName === 'Alpaca' ? [...ALPACA_ORDER_RULES] : [...SUPPORTED_ORDER_RULES],
      supportedDurations: [...SUPPORTED_DURATIONS],
      supportsMarketBrackets: true,
      supportsMultipleExitLevels: providerName !== 'Alpaca',
      supportsUnpairedExitLevels: true,
      supportsStopLoss: true,
      supportsTrailingStop: true,
      supportsGuaranteedStop: false,
      orderTicketCustomFields:
        providerName === 'Alpaca' ? [] : [...IBKR_ORDER_TICKET_CUSTOM_FIELDS],
    },
    customFields: {
      availableFunds: account.availableFunds,
      dailyPnl: account.dailyPnl,
      unrealizedPnl: account.unrealizedPnl,
      realizedPnl: account.realizedPnl,
    },
  })
}

export function providerEnvironmentLabel(
  providerName: 'IBKR' | 'Alpaca',
  executionEnvironment: TradingExecutionEnvironment | undefined,
): string {
  if (executionEnvironment === undefined) return providerName
  return `${providerName} ${executionEnvironment}`
}

export function toTradingOrder(order: BackendOrder): TradingOrder {
  const transmission = orderTransmissionPresentation(order.status, order.message)
  const orderVisibility = order.displaySize
    ? 'iceberg'
    : order.hidden
      ? 'hidden'
      : (order.customFields?.orderVisibility ?? 'visible')
  return withoutUndefined<TradingOrder>({
    id: order.id,
    accountId: order.accountId ?? '',
    symbol: toSdkSymbolInfo(order.symbol),
    customFields: {
      assetClass: order.symbol.assetClass,
      ...order.customFields,
      orderVisibility,
      ...(order.displaySize === undefined ? {} : { displaySize: order.displaySize }),
    },
    side: order.side,
    type: order.type,
    brokerOrderTypeId: order.brokerOrderTypeId,
    status: transmission.status,
    quantity: order.quantity,
    cashQuantity: order.cashQuantity,
    filledQuantity: order.filledQuantity,
    remainingQuantity: order.remainingQuantity,
    price: order.limitPrice,
    stopPrice: order.stopPrice,
    trailPercent: order.trailPercent,
    trailingStopPips: order.trailingStopPips,
    relativeOffset: order.relativeOffset,
    postOnly: order.postOnly,
    routingDestination: order.routingDestination,
    allOrNone: order.allOrNone,
    oca: order.oca,
    stopType: order.stopType,
    guaranteedStop: order.guaranteedStop,
    hidden: order.hidden,
    averagePrice: order.avgFillPrice,
    duration: toTradingDuration(order.duration, order.durationDateTime),
    createdAt: Date.parse(order.submittedAt),
    updatedAt: Date.parse(order.updatedAt),
    message:
      (transmission.message?.trim() ? transmission.message : undefined) ??
      (transmission.status === 'pre-submitted'
        ? ['stop', 'stop-limit', 'trailing-stop', 'trailing-stop-limit'].includes(order.type)
          ? 'Accepted by broker; waiting for stop trigger.'
          : 'Accepted by broker; held until its activation conditions are met.'
        : undefined),
    metadata: {
      brokerStatus: order.status,
      brokerMessage: order.message,
      ...(transmission.held ? { transmissionStatus: 'held', requiresTwsAttention: true } : {}),
    },
    parentId: order.parentId,
    parentType: order.parentType,
    bracketGroupId: order.bracketGroupId,
    exitLevelId: order.exitLevelId,
    optionLegs: order.optionLegs?.map((leg) => ({
      ...leg,
      contract: toTradingOptionContract(leg.contract),
    })),
    strategyLegs: order.strategyLegs?.map((leg) =>
      leg.instrument === 'option'
        ? { ...leg, contract: toTradingOptionContract(leg.contract) }
        : {
            ...leg,
            symbolInfo: toSdkSymbolInfo(leg.symbolInfo),
          },
    ),
  })
}

function toTradingPosition(position: BackendPosition): TradingPosition {
  return withoutUndefined<TradingPosition>({
    id: position.id,
    accountId: position.accountId,
    symbol: toSdkSymbolInfo(position.symbol),
    side: position.quantity > 0 ? 'long' : position.quantity < 0 ? 'short' : 'flat',
    quantity: Math.abs(position.quantity),
    averagePrice: ['futures', 'futures-option', 'option', 'event-contract'].includes(
      position.symbol.assetClass ?? '',
    )
      ? position.averagePrice
      : position.avgCost,
    marketPrice: position.markPrice,
    optionContract: position.optionContract
      ? toTradingOptionContract(position.optionContract)
      : undefined,
    unrealizedPnl: position.unrealizedPnl,
    realizedPnl: position.realizedPnl,
    currency: position.symbol.currency ?? 'USD',
    customFields: {
      assetClass: position.symbol.assetClass,
      marketValue: position.marketValue,
      pnlCurrency: position.pnlCurrency,
    },
  })
}

function toTradingExecution(execution: BackendExecution): TradingState['executions'][number] {
  return withoutUndefined<TradingState['executions'][number]>({
    id: execution.id,
    accountId: execution.accountId ?? '',
    orderId: execution.orderId,
    positionId: execution.positionId,
    symbol: toSdkSymbolInfo(execution.symbol),
    optionContract: execution.optionContract
      ? toTradingOptionContract(execution.optionContract)
      : undefined,
    side: execution.side,
    quantity: execution.quantity,
    price: execution.price,
    time: Date.parse(execution.timestamp),
    currency: execution.symbol.currency ?? 'USD',
    metadata: {
      assetClass: execution.symbol.assetClass,
    },
  })
}

function formatCurrency(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value)
}

function formatCommissionRange(
  range: { minimum?: number | undefined; maximum?: number | undefined },
  currency?: string,
): string {
  const format = (value: number) => (currency ? formatCurrency(value, currency) : String(value))
  const value =
    range.minimum !== undefined && range.maximum !== undefined
      ? range.minimum === range.maximum
        ? format(range.minimum)
        : `${format(range.minimum)} – ${format(range.maximum)}`
      : range.minimum !== undefined
        ? `From ${format(range.minimum)}`
        : range.maximum !== undefined
          ? `Up to ${format(range.maximum)}`
          : 'Unavailable'
  return currency || value === 'Unavailable' ? value : `${value} (currency unavailable)`
}

export function toBackendPatch(patch: TradingOrderPatch): BackendOrderPatch {
  const orderVisibility = patch.customFields?.orderVisibility
  const displaySizeValue = patch.customFields?.displaySize
  return withoutUndefined<BackendOrderPatch>({
    brokerOrderTypeId: patch.brokerOrderTypeId,
    quantity: patch.quantity,
    limitPrice: patch.price,
    stopPrice: patch.stopPrice,
    trailPercent: patch.trailPercent,
    trailingStopPips: patch.trailingStopPips,
    relativeOffset: patch.relativeOffset,
    postOnly: patch.postOnly,
    displaySize:
      orderVisibility === 'iceberg' && displaySizeValue !== undefined && displaySizeValue !== ''
        ? Number(displaySizeValue)
        : orderVisibility === 'visible' || orderVisibility === 'hidden'
          ? null
          : undefined,
    routingDestination: patch.routingDestination,
    allOrNone: patch.allOrNone,
    oca: patch.oca === null ? null : toBackendOca(patch.oca),
    stopType: patch.stopType,
    guaranteedStop: patch.guaranteedStop,
    duration: patch.duration ? toBackendDuration(patch.duration) : undefined,
    durationDateTime: patch.duration?.datetime,
    exits: patch.exits,
    exitLevelId: patch.exitLevelId,
    confirmId: patch.confirmId,
    customFields: toBackendOrderCustomFields(patch.customFields),
  })
}

export function toOrderPreviewResult(result: BackendOrderPreviewResult): TradingOrderPreviewResult {
  const estimatedCost = Number(result.estimatedCost)
  const sections: NonNullable<TradingOrderPreviewResult['sections']> = []
  if (
    result.estimatedCostSource === 'broker' &&
    result.estimatedCostCurrency &&
    Number.isFinite(estimatedCost) &&
    estimatedCost > 0
  ) {
    sections.push({
      rows: [
        {
          label: 'Estimated notional',
          value: formatCurrency(estimatedCost, result.estimatedCostCurrency),
        },
      ],
    })
  }
  if (result.exitCommissions?.length) {
    const levelIds = [...new Set(result.exitCommissions.map((exit) => exit.levelId))]
    sections.push({
      title: 'Potential exit commission · TP / SL are alternatives',
      rows: result.exitCommissions.map((exit) => ({
        label: `${levelIds.length > 1 ? `Level ${levelIds.indexOf(exit.levelId) + 1} · ` : ''}${exit.leg === 'take-profit' ? 'Take profit' : 'Stop loss'} (${exit.quantity})`,
        value:
          exit.estimatedCommission === undefined
            ? exit.estimatedCommissionRange === undefined
              ? 'Unavailable'
              : formatCommissionRange(exit.estimatedCommissionRange, exit.commissionCurrency)
            : exit.commissionCurrency
              ? formatCurrency(exit.estimatedCommission, exit.commissionCurrency)
              : `${exit.estimatedCommission} (currency unavailable)`,
      })),
    })
  }
  return withoutUndefined<TradingOrderPreviewResult>({
    accepted: result.accepted,
    ...(result.reason === undefined ? {} : { message: result.reason }),
    ...(result.estimatedCommission === undefined
      ? {}
      : { estimatedCommission: result.estimatedCommission }),
    ...(result.estimatedCommissionRange === undefined
      ? {}
      : { estimatedCommissionRange: result.estimatedCommissionRange }),
    ...(result.commissionCurrency === undefined
      ? {}
      : { commissionCurrency: result.commissionCurrency }),
    ...(result.estimatedFees === undefined ? {} : { estimatedFees: result.estimatedFees }),
    ...(result.feesCurrency === undefined ? {} : { feesCurrency: result.feesCurrency }),
    ...(result.marginCurrency === undefined ? {} : { marginCurrency: result.marginCurrency }),
    ...(result.estimatedMargin === undefined ? {} : { estimatedMargin: result.estimatedMargin }),
    ...(result.confirmId === undefined ? {} : { confirmId: result.confirmId }),
    ...(result.fieldErrors === undefined ? {} : { fieldErrors: result.fieldErrors }),
    ...(sections.length ? { sections } : {}),
    ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
  })
}

function toSdkSymbolInfo(symbol: BackendSymbol): SymbolInfo {
  if (symbol.sourceSymbol) {
    return withoutUndefined<SymbolInfo>({
      ...symbol.sourceSymbol,
      type: toSdkSymbolType(symbol.sourceSymbol.type),
    })
  }
  return withoutUndefined<SymbolInfo>({
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
    type: toSdkSymbolType(symbol.assetClass),
  })
}

function toSdkSymbolType(assetClass: string | undefined): SymbolInfo['type'] {
  switch (assetClass) {
    case 'futures-option':
      return 'option'
    case 'stock':
    case 'option':
    case 'forex':
    case 'crypto':
    case 'futures':
    case 'bond':
    case 'warrant':
    case 'commodity':
    case 'cfd':
    case 'fund':
    case 'index':
    case 'event-contract':
      return assetClass
    default:
      return undefined
  }
}

export function toTradingOptionContract(
  contract: import('./types').BackendOptionContract,
): TradingOptionContract {
  return withoutUndefined<TradingOptionContract>({
    ...contract,
    underlyingSymbolInfo: toSdkSymbolInfo(contract.underlyingSymbolInfo),
  })
}
