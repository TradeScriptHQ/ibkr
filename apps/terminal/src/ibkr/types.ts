import type {
  OptionContract as BackendOptionContract,
  OptionOrderLegDraft as BackendOptionOrderLegDraft,
  OrderDraft as BackendOrderDraft,
  OrderDuration as BackendOrderDuration,
  SourceSymbolIdentity as BackendSourceSymbolIdentity,
  StrategyOrderLegDraft as BackendStrategyOrderLegDraft,
} from '@ibkr-terminal/contracts'
import type {
  SymbolInfo,
  TradingOptionContract,
  TradingOptionOrderLegDraft,
  TradingOrderContext,
  TradingOrderDraft,
  TradingOrderDuration,
  TradingOrderType,
  TradingStrategyOrderLegDraft,
} from '@tradescript/pro/sdk'

export type {
  AccountSummary as BackendAccount,
  BridgeDiagnostic as BackendDiagnostic,
  BridgeMessage as BackendMessage,
  BrokerEvent as BackendEvent,
  BrokerState as BackendState,
  BrokerSymbol as BackendSymbol,
  Execution as BackendExecution,
  HealthResponse as BackendHealth,
  MarketQuote as BackendQuote,
  OptionChainContract as BackendOptionChainContract,
  OptionChainExpiration as BackendOptionChainExpiration,
  OptionChainResult as BackendOptionChainResult,
  OptionContract as BackendOptionContract,
  OptionContractResolution as BackendOptionContractResolution,
  OptionOrderLegDraft as BackendOptionOrderLegDraft,
  Order as BackendOrder,
  OrderDraft as BackendOrderDraft,
  OrderDuration as BackendOrderDuration,
  OrderExitLevel as BackendOrderExitLevel,
  OrderExitPlan as BackendOrderExitPlan,
  OrderPatch as BackendOrderPatch,
  OrderPreviewResult as BackendOrderPreviewResult,
  OrderProtectiveStop as BackendOrderProtectiveStop,
  OrderType as BackendOrderType,
  PlaceOrderResult as BackendPlaceOrderResult,
  Position as BackendPosition,
  SourceSymbolIdentity as BackendSourceSymbolIdentity,
  StrategyOrderLegDraft as BackendStrategyOrderLegDraft,
} from '@ibkr-terminal/contracts'

export function toBackendDuration(
  duration: TradingOrderDuration | undefined,
): BackendOrderDraft['duration'] {
  if (
    duration?.type === 'gtc' ||
    duration?.type === 'gtd' ||
    duration?.type === 'ioc' ||
    duration?.type === 'fok'
  ) {
    return duration.type
  }
  if (duration?.type === 'custom') {
    const value = duration.value
      ?.trim()
      .toLowerCase()
      .replace(/[+_\s]+/g, '-')
    if (value === 'opg' || value === 'overnight' || value === 'overnight-day') return value
  }
  return 'day'
}

export function toTradingDuration(
  duration: BackendOrderDuration,
  datetime?: number,
): TradingOrderDuration {
  if (
    duration === 'day' ||
    duration === 'gtc' ||
    duration === 'gtd' ||
    duration === 'ioc' ||
    duration === 'fok'
  ) {
    return { type: duration, ...(datetime === undefined ? {} : { datetime }) }
  }
  return {
    type: 'custom',
    value: duration,
    label:
      duration === 'opg' ? 'OPG' : duration === 'overnight-day' ? 'OVERNIGHT + DAY' : 'OVERNIGHT',
    ...(datetime === undefined ? {} : { datetime }),
  }
}

export function toBackendDraft(
  draft: TradingOrderDraft,
  _context?: TradingOrderContext,
): BackendOrderDraft {
  if (draft.parentType && draft.parentType !== 'order') {
    throw new Error(`The local paper bridge does not support ${draft.parentType} parent drafts.`)
  }
  const symbol = draft.symbol
  if (!symbol.currency) {
    throw new Error(
      'The instrument currency is unavailable. Resolve the instrument before submitting an order.',
    )
  }
  const orderVisibility = draft.customFields?.orderVisibility
  const displaySizeValue = draft.customFields?.displaySize
  const displaySize =
    orderVisibility === 'iceberg' && displaySizeValue !== undefined && displaySizeValue !== ''
      ? Number(displaySizeValue)
      : undefined
  return {
    accountId: draft.accountId,
    symbol: {
      symbol: symbol.brokerSymbol ?? symbol.ticker,
      exchange: symbol.exchange,
      primaryExchange: symbol.listedExchange,
      currency: symbol.currency,
      assetClass: symbol.type,
      sourceSymbol: toBackendSourceSymbolIdentity(symbol),
    },
    side: draft.side,
    type: requireSupportedBackendOrderType(draft.type),
    brokerOrderTypeId: draft.brokerOrderTypeId,
    duration: toBackendDuration(draft.duration),
    durationDateTime: draft.duration?.datetime,
    quantity: draft.quantity,
    cashQuantity: draft.cashQuantity,
    limitPrice: draft.price,
    stopPrice: draft.stopPrice,
    trailPercent: draft.trailPercent,
    trailingStopPips: draft.trailingStopPips,
    relativeOffset: draft.relativeOffset,
    postOnly: draft.postOnly,
    routingDestination: draft.routingDestination,
    allOrNone: draft.allOrNone,
    oca: toBackendOca(draft.oca),
    displaySize,
    stopType: draft.stopType,
    guaranteedStop: draft.guaranteedStop,
    hidden: orderVisibility === 'hidden' || draft.customFields?.hidden === true,
    outsideRth: draft.customFields?.outsideRth === true,
    takeProfitOutsideRth: draft.customFields?.takeProfitOutsideRth === true,
    exits: draft.exits,
    parentId: draft.parentId,
    parentType: draft.parentType,
    bracketGroupId: draft.bracketGroupId,
    exitLevelId: draft.exitLevelId,
    optionLegs: draft.optionLegs?.map(toBackendOptionOrderLeg),
    strategyLegs: draft.strategyLegs?.map(toBackendStrategyOrderLeg),
    confirmId: draft.confirmId,
    customFields: toBackendOrderCustomFields(draft.customFields),
  }
}

export function toBackendOrderCustomFields(
  customFields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!customFields || customFields.orderVisibility === 'iceberg') return customFields
  const { displaySize: _displaySize, ...rest } = customFields
  return rest
}

export function toBackendStrategyOrderLeg(
  leg: TradingStrategyOrderLegDraft,
): BackendStrategyOrderLegDraft {
  if (leg.instrument === 'option') return { ...toBackendOptionOrderLeg(leg), instrument: 'option' }
  return {
    instrument: 'equity',
    id: leg.id,
    symbol: leg.symbol,
    symbolInfo: {
      symbol: leg.symbol,
      exchange: leg.symbolInfo.exchange ?? leg.exchange,
      primaryExchange: leg.symbolInfo.listedExchange,
      currency: leg.symbolInfo.currency ?? leg.currency,
      assetClass: leg.symbolInfo.type,
      sourceSymbol: toBackendSourceSymbolIdentity(leg.symbolInfo),
    },
    exchange: leg.exchange,
    currency: leg.currency,
    side: leg.side,
    positionEffect: leg.positionEffect,
    quantity: leg.quantity,
    ratio: leg.ratio,
    price: leg.price,
  }
}

export function toBackendOptionOrderLeg(
  leg: TradingOptionOrderLegDraft,
): BackendOptionOrderLegDraft {
  return {
    id: leg.id,
    contract: toBackendOptionContract(leg.contract),
    side: leg.side,
    positionEffect: leg.positionEffect,
    quantity: leg.quantity,
    ratio: leg.ratio,
    price: leg.price,
  }
}

export function toBackendOptionContract(contract: TradingOptionContract): BackendOptionContract {
  return {
    underlying: contract.underlying,
    underlyingSymbolInfo: {
      symbol: contract.underlying,
      exchange: contract.underlyingSymbolInfo.exchange,
      primaryExchange: contract.underlyingSymbolInfo.listedExchange,
      currency: contract.underlyingSymbolInfo.currency ?? contract.currency,
      assetClass: contract.underlyingSymbolInfo.type,
      sourceSymbol: toBackendSourceSymbolIdentity(contract.underlyingSymbolInfo),
    },
    expiration: contract.expiration,
    strike: contract.strike,
    right: contract.right,
    multiplier: contract.multiplier,
    exchange: contract.exchange,
    route: contract.route,
    currency: contract.currency,
    symbol: contract.symbol,
    brokerContractId: contract.brokerContractId,
    priceStep: contract.priceStep,
  }
}

export function toBackendSourceSymbolIdentity(symbol: SymbolInfo): BackendSourceSymbolIdentity {
  return { ...symbol }
}

export function requireSupportedBackendOrderType(
  type: TradingOrderType,
): BackendOrderDraft['type'] {
  if (SUPPORTED_BACKEND_ORDER_TYPES.has(type)) return type as BackendOrderDraft['type']
  throw new Error(`The local paper bridge does not support the ${type} order type.`)
}

const SUPPORTED_BACKEND_ORDER_TYPES = new Set<TradingOrderType>([
  'market',
  'limit',
  'midprice',
  'market-to-limit',
  'stop',
  'stop-limit',
  'trailing-stop',
  'trailing-stop-limit',
  'peg-mid',
  'market-on-close',
  'limit-on-close',
  'adaptive',
  'ib-algo',
])

export function toBackendOca(oca: TradingOrderDraft['oca']): BackendOrderDraft['oca'] {
  if (!oca) return undefined
  switch (oca.behavior) {
    case 'cancel-with-block':
    case 'reduce-with-block':
    case 'reduce-without-block':
      return { groupId: oca.groupId, behavior: oca.behavior }
    default:
      throw new Error(`Unsupported IBKR OCA behavior: ${oca.behavior}`)
  }
}
