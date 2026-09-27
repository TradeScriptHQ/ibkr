import { normalizeStockRoutingExchange, resolveAssetClass } from './contracts.js'
import { positivePrice, positiveQuantity, quantityGreaterThan } from './numbers.js'
import { hasOptionLegs, hasStrategyLegs } from './order-strategy.js'
import type {
  BrokerSymbol,
  OptionOrderLegDraft,
  OrderDraft,
  OrderDuration,
  OrderExitLevel,
  OrderPatch,
  OrderPreviewResult,
  OrderType,
} from './types.js'

export function previewConfirmationId(): string {
  return `ibkr-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function validateDraft(draft: OrderDraft): OrderPreviewResult {
  const symbol = draft.symbol.symbol?.trim()
  if (!symbol) {
    return { accepted: false, reason: 'An IBKR broker symbol is required.' }
  }
  const sourceCurrency = draft.symbol.sourceSymbol?.currency
  if (sourceCurrency && draft.symbol.currency !== sourceCurrency) {
    return {
      accepted: false,
      reason: `Order contract currency ${draft.symbol.currency ?? 'missing'} does not match instrument currency ${sourceCurrency}. Resolve the instrument again.`,
    }
  }
  if (!isSupportedOrderType(draft.type)) {
    return { accepted: false, reason: `Unsupported order type ${draft.type}.` }
  }
  if (!isSupportedDuration(draft.duration)) {
    return { accepted: false, reason: `Unsupported duration ${draft.duration}.` }
  }
  const assetClass = resolveAssetClass(draft.symbol.assetClass, draft.symbol.exchange)
  if (
    draft.routingDestination !== undefined &&
    !isValidRoutingDestination(draft.routingDestination)
  ) {
    return { accepted: false, reason: 'Routing destination is not a valid IBKR venue identifier.' }
  }
  if (
    draft.duration === 'overnight-day' &&
    draft.routingDestination !== undefined &&
    normalizeStockRoutingExchange(draft.routingDestination) !== 'SMART'
  ) {
    return {
      accepted: false,
      reason: 'IBKR Overnight + DAY orders require SMART routing.',
    }
  }
  if (draft.allOrNone && !supportsAllOrNone(draft)) {
    return {
      accepted: false,
      reason: 'All-or-None is currently supported only for USD stock or option limit orders.',
    }
  }
  if (draft.oca) {
    if (!draft.oca.groupId.trim()) {
      return { accepted: false, reason: 'OCA orders require a non-empty group identifier.' }
    }
    if (draft.oca.groupId.trim().length > 64) {
      return { accepted: false, reason: 'OCA group identifiers may not exceed 64 characters.' }
    }
    if (
      draft.oca.behavior !== 'cancel-with-block' &&
      draft.oca.behavior !== 'reduce-with-block' &&
      draft.oca.behavior !== 'reduce-without-block'
    ) {
      return { accepted: false, reason: 'Unsupported IBKR OCA behavior.' }
    }
  }
  if (draft.duration === 'gtd' && !isValidGtdDateTime(draft.durationDateTime)) {
    return { accepted: false, reason: 'GTD orders require a future expiry date/time.' }
  }
  const isCryptoCashMarketBuy =
    assetClass === 'crypto' && draft.side === 'buy' && draft.type === 'market'
  if (isCryptoCashMarketBuy) {
    if (!Number.isFinite(draft.cashQuantity) || Number(draft.cashQuantity) <= 0) {
      return { accepted: false, reason: 'Crypto market buys require a cash amount.' }
    }
    if (draft.quantity !== 0) {
      return {
        accepted: false,
        reason: 'Crypto market buys use cash amount and cannot also specify instrument quantity.',
      }
    }
    if (draft.duration !== 'ioc') {
      return { accepted: false, reason: 'Crypto market orders require IOC duration.' }
    }
    if (draft.exits) {
      return { accepted: false, reason: 'Crypto cash-amount market buys cannot attach exits.' }
    }
  } else {
    if (draft.cashQuantity !== undefined) {
      return {
        accepted: false,
        reason: 'Cash amount is supported only for cryptocurrency market buys.',
      }
    }
    if (!Number.isFinite(draft.quantity) || draft.quantity <= 0) {
      return { accepted: false, reason: 'Quantity must be greater than zero.' }
    }
  }
  const displaySizeValidation = validateDisplaySize(draft)
  if (displaySizeValidation) return displaySizeValidation
  if (draft.optionLegs !== undefined && draft.optionLegs.length === 0) {
    return { accepted: false, reason: 'Option order requires at least one option leg.' }
  }
  if (draft.strategyLegs !== undefined && draft.strategyLegs.length === 0) {
    return { accepted: false, reason: 'Strategy order requires at least one leg.' }
  }
  if (hasOptionLegs(draft) && hasStrategyLegs(draft)) {
    return {
      accepted: false,
      reason: 'An order cannot contain both option legs and strategy legs.',
    }
  }
  if (draft.exits && (hasOptionLegs(draft) || hasStrategyLegs(draft))) {
    return {
      accepted: false,
      reason: 'Typed option and strategy orders cannot also contain stock exit plans.',
    }
  }
  if (hasStrategyLegs(draft)) {
    return validateStrategyDraft(draft)
  }
  if (hasOptionLegs(draft)) {
    return validateOptionDraft(draft)
  }
  if (assetClass === 'index')
    return {
      accepted: false,
      reason:
        'Cash indices are reference data and cannot be traded. Select an option or future instead.',
    }
  if (assetClass === 'fund')
    return {
      accepted: false,
      reason: 'IBKR does not support mutual fund trading in paper accounts.',
    }
  if (assetClass === 'crypto') {
    if (draft.type !== 'market' && draft.type !== 'limit') {
      return { accepted: false, reason: 'Cryptocurrency orders support only market and limit.' }
    }
    if (draft.type === 'market' && draft.duration !== 'ioc') {
      return { accepted: false, reason: 'Crypto market orders require IOC duration.' }
    }
    if (draft.type === 'limit' && !['day', 'gtc', 'ioc'].includes(draft.duration)) {
      return { accepted: false, reason: 'Crypto limit orders support DAY, GTC or IOC duration.' }
    }
  }
  if (assetClass === 'event-contract') {
    if (draft.symbol.exchange !== 'FORECASTX' || draft.side !== 'buy')
      return {
        accepted: false,
        reason:
          'ForecastEx contracts are buy-only. Reduce a position by buying the opposing outcome.',
      }
    if (
      draft.type !== 'limit' ||
      !['day', 'gtc', 'ioc'].includes(draft.duration) ||
      !Number.isInteger(draft.quantity) ||
      !(Number(draft.limitPrice) >= 0.01 && Number(draft.limitPrice) <= 0.99)
    )
      return {
        accepted: false,
        reason:
          'ForecastEx requires a limit price from 0.01 to 0.99, whole contracts, and DAY, GTC or IOC duration.',
      }
    if (draft.exits)
      return { accepted: false, reason: 'ForecastEx exit orders must buy the opposing outcome.' }
  }
  if (
    assetClass &&
    !['stock', 'crypto', 'forex'].includes(assetClass) &&
    (!draft.symbol.exchange ||
      !draft.symbol.currency ||
      !(/^IBKR:[1-9][0-9]*$/.test(draft.symbol.symbol) || draft.symbol.contractIdentity?.conId))
  )
    return { accepted: false, reason: 'Select an exact IBKR contract before trading.' }
  if (assetClass === 'futures' && !Number.isInteger(draft.quantity))
    return { accepted: false, reason: 'Futures quantity must be a whole number of contracts.' }
  if (!assetClass) {
    return {
      accepted: false,
      reason:
        'This instrument type is not enabled for trading. Supported types are equities, IBKR crypto, IDEALPRO forex, and option orders with typed legs.',
    }
  }
  if (orderNeedsLimitPrice(draft.type) && !positivePrice(draft.limitPrice)) {
    return {
      accepted: false,
      reason: `${orderTypeDisplayName(draft.type)} requires a limit price.`,
    }
  }
  if (orderNeedsStopPrice(draft.type) && !positivePrice(draft.stopPrice)) {
    return { accepted: false, reason: `${orderTypeDisplayName(draft.type)} requires a stop price.` }
  }
  if (orderNeedsTrailPercent(draft.type) && !positivePrice(draft.trailPercent)) {
    return {
      accepted: false,
      reason: `${orderTypeDisplayName(draft.type)} requires a trailing percent.`,
    }
  }
  if (draft.exits) return validateExitPlan(draft)
  return { accepted: true }
}

export function applyOrderPatch(existing: OrderDraft, patch: OrderPatch): OrderDraft {
  const customFields =
    patch.displaySize === null && patch.customFields
      ? Object.fromEntries(
          Object.entries(patch.customFields).filter(([field]) => field !== 'displaySize'),
        )
      : patch.customFields
  return {
    ...existing,
    ...patch,
    oca: patch.oca === null ? undefined : (patch.oca ?? existing.oca),
    displaySize:
      patch.displaySize === null ? undefined : (patch.displaySize ?? existing.displaySize),
    ...(customFields === undefined ? {} : { customFields }),
  }
}

function validateOptionDraft(draft: OrderDraft): OrderPreviewResult {
  if (draft.type !== 'limit' && draft.type !== 'market') {
    return {
      accepted: false,
      reason: 'Option orders currently support market and limit order types.',
    }
  }
  if (draft.type === 'limit' && !positivePrice(draft.limitPrice)) {
    return { accepted: false, reason: 'Option limit orders require a limit price.' }
  }
  const legs = draft.optionLegs ?? []
  const firstLeg = legs[0]
  if (!firstLeg) {
    return { accepted: false, reason: 'Option order requires at least one option leg.' }
  }
  const underlying = firstLeg.contract.underlying.trim().toUpperCase()
  if (!underlying || !sameOptionUnderlying(firstLeg, draft.symbol)) {
    return {
      accepted: false,
      reason: 'Option legs must use the same underlying as the order symbol.',
    }
  }
  for (const leg of legs) {
    if (!sameOptionUnderlying(leg, draft.symbol))
      return { accepted: false, reason: 'All option legs must use the exact order underlying.' }
    const validation = validateOptionLeg(leg, underlying)
    if (!validation.accepted) return validation
  }
  return { accepted: true }
}

function sameOptionUnderlying(leg: OptionOrderLegDraft, symbol: BrokerSymbol): boolean {
  const identity = (value: BrokerSymbol): string | undefined =>
    value.canonicalSymbol ??
    (value.contractIdentity?.conId
      ? `IBKR:${value.contractIdentity.conId}`
      : /^IBKR:[1-9][0-9]*$/.test(value.symbol)
        ? value.symbol
        : undefined)
  const orderIdentity = identity(symbol)
  const optionIdentity = identity(leg.contract.underlyingSymbolInfo)
  if (orderIdentity && optionIdentity) return orderIdentity === optionIdentity
  return leg.contract.underlying.trim().toUpperCase() === symbol.symbol.trim().toUpperCase()
}

function validateStrategyDraft(draft: OrderDraft): OrderPreviewResult {
  if (draft.type !== 'limit' && draft.type !== 'market') {
    return {
      accepted: false,
      reason: 'Strategy orders currently support market and limit order types.',
    }
  }
  if (draft.type === 'limit' && !positivePrice(draft.limitPrice)) {
    return { accepted: false, reason: 'Strategy limit orders require a limit price.' }
  }
  const legs = draft.strategyLegs ?? []
  if (!legs.length) return { accepted: false, reason: 'Strategy order requires at least one leg.' }
  const underlying = draft.symbol.symbol.trim().toUpperCase()
  const units = legs.map((leg) =>
    leg.instrument === 'equity' ? leg.quantity / leg.ratio : leg.quantity,
  )
  if (
    units.some((unit) => !Number.isFinite(unit) || unit <= 0) ||
    units.some((unit) => Math.abs(unit - Number(units[0])) > 1e-8)
  ) {
    return {
      accepted: false,
      reason: 'Strategy leg quantities and ratios must represent the same strategy-unit quantity.',
    }
  }
  for (const leg of legs) {
    if (leg.instrument === 'option') {
      const validation = validateOptionLeg(leg, underlying)
      if (!validation.accepted) return validation
      continue
    }
    if (leg.symbol.trim().toUpperCase() !== underlying) {
      return { accepted: false, reason: 'All strategy legs must use the same underlying.' }
    }
    if (!positiveQuantity(leg.quantity) || !positiveQuantity(leg.ratio)) {
      return {
        accepted: false,
        reason: 'Equity strategy legs require positive quantity and ratio.',
      }
    }
  }
  return { accepted: true }
}

function validateOptionLeg(leg: OptionOrderLegDraft, underlying: string): OrderPreviewResult {
  const contract = leg.contract
  if (contract.exchange === 'FORECASTX' || contract.route === 'FORECASTX')
    return {
      accepted: false,
      reason: 'ForecastEx orders require an exact event contract with buy-only outcome semantics.',
    }
  if (contract.underlying.trim().toUpperCase() !== underlying) {
    return { accepted: false, reason: 'All option legs in one combo must use the same underlying.' }
  }
  if (!validOptionExpiration(contract.expiration)) {
    return { accepted: false, reason: `Invalid option expiration ${contract.expiration}.` }
  }
  if (!Number.isFinite(contract.strike) || contract.strike <= 0) {
    return { accepted: false, reason: 'Option legs require a positive strike.' }
  }
  if (contract.right !== 'call' && contract.right !== 'put') {
    return { accepted: false, reason: 'Option leg right must be call or put.' }
  }
  if (!Number.isFinite(contract.multiplier) || contract.multiplier <= 0) {
    return { accepted: false, reason: 'Option legs require a positive multiplier.' }
  }
  if (!Number.isFinite(leg.quantity) || leg.quantity <= 0) {
    return { accepted: false, reason: 'Option legs require a positive quantity.' }
  }
  if (leg.ratio != null && (!Number.isFinite(leg.ratio) || leg.ratio <= 0)) {
    return { accepted: false, reason: 'Option legs require a positive ratio.' }
  }
  if (leg.price != null && (!Number.isFinite(leg.price) || leg.price < 0)) {
    return { accepted: false, reason: 'Option leg premiums must be zero or greater.' }
  }
  return { accepted: true }
}

function validateExitPlan(draft: OrderDraft): OrderPreviewResult {
  const levels = draft.exits?.levels ?? []
  if (levels.length === 0)
    return { accepted: false, reason: 'An exit plan requires at least one level.' }
  if (new Set(levels.map((level) => level.id)).size !== levels.length) {
    return { accepted: false, reason: 'Exit level IDs must be unique.' }
  }
  for (const level of levels) {
    if (!level.id) return { accepted: false, reason: 'Each exit level requires an ID.' }
    if (!positiveQuantity(level.quantity))
      return { accepted: false, reason: 'Exit level quantities must be greater than zero.' }
    if (!level.takeProfit && !level.stopLoss)
      return { accepted: false, reason: 'Each exit level requires a take-profit or stop-loss.' }
    if (level.takeProfit && !positivePrice(level.takeProfit.price))
      return { accepted: false, reason: 'Take-profit prices must be greater than zero.' }
    if (level.stopLoss?.kind === 'fixed') {
      if (!positivePrice(level.stopLoss.triggerPrice))
        return { accepted: false, reason: 'Fixed stops require a trigger price.' }
      if (level.stopLoss.limitPrice != null && !positivePrice(level.stopLoss.limitPrice))
        return {
          accepted: false,
          reason: 'Stop-limit exits require a limit price greater than zero.',
        }
    }
    if (level.stopLoss?.kind === 'trailing' && !positivePrice(level.stopLoss.trailingPips)) {
      return { accepted: false, reason: 'Trailing stops require a positive pip distance.' }
    }
    if (level.stopLoss?.kind === 'guaranteed') {
      return { accepted: false, reason: 'IBKR does not support guaranteed stops.' }
    }
  }
  const takeProfitQuantity = sumExitQuantities(levels, 'take-profit')
  const stopLossQuantity = sumExitQuantities(levels, 'stop-loss')
  if (
    quantityGreaterThan(takeProfitQuantity, draft.quantity) ||
    quantityGreaterThan(stopLossQuantity, draft.quantity)
  ) {
    return { accepted: false, reason: 'Exit quantities cannot exceed the entry quantity.' }
  }
  const referencePrice = entryReferencePrice(draft)
  if (positivePrice(referencePrice)) {
    const takeProfitPrices = levels.flatMap((level) =>
      level.takeProfit ? [level.takeProfit.price] : [],
    )
    const stopPrices = levels.flatMap((level) =>
      level.stopLoss?.kind === 'fixed' ? [level.stopLoss.triggerPrice] : [],
    )
    if (draft.side === 'buy') {
      if (takeProfitPrices.some((price) => price <= referencePrice))
        return { accepted: false, reason: 'Buy take-profit exits must be above entry.' }
      if (stopPrices.some((price) => price >= referencePrice))
        return { accepted: false, reason: 'Buy stop-loss exits must be below entry.' }
    } else {
      if (takeProfitPrices.some((price) => price >= referencePrice))
        return { accepted: false, reason: 'Sell take-profit exits must be below entry.' }
      if (stopPrices.some((price) => price <= referencePrice))
        return { accepted: false, reason: 'Sell stop-loss exits must be above entry.' }
    }
  }
  return { accepted: true }
}

function sumExitQuantities(levels: OrderExitLevel[], leg: 'take-profit' | 'stop-loss'): number {
  return levels.reduce((sum, level) => {
    const hasLeg = leg === 'take-profit' ? Boolean(level.takeProfit) : Boolean(level.stopLoss)
    return sum + (hasLeg ? level.quantity : 0)
  }, 0)
}

function isSupportedOrderType(type: OrderType): boolean {
  switch (type) {
    case 'market':
    case 'limit':
    case 'midprice':
    case 'market-to-limit':
    case 'stop':
    case 'stop-limit':
    case 'trailing-stop':
    case 'trailing-stop-limit':
    case 'peg-mid':
    case 'market-on-close':
    case 'limit-on-close':
    case 'adaptive':
    case 'ib-algo':
      return true
    default:
      return false
  }
}

function isSupportedDuration(duration: OrderDuration): boolean {
  return (
    duration === 'day' ||
    duration === 'gtc' ||
    duration === 'gtd' ||
    duration === 'ioc' ||
    duration === 'fok' ||
    duration === 'opg' ||
    duration === 'overnight-day' ||
    duration === 'overnight'
  )
}

function isValidGtdDateTime(value: number | undefined): boolean {
  return Number.isFinite(value) && Number(value) > Date.now()
}

function isValidRoutingDestination(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9._-]{0,31}$/u.test(value.trim().toUpperCase())
}

function supportsAllOrNone(draft: OrderDraft): boolean {
  if (draft.type !== 'limit' || draft.symbol.currency?.toUpperCase() !== 'USD') return false
  if (hasStrategyLegs(draft)) return false
  if (hasOptionLegs(draft)) return true
  return resolveAssetClass(draft.symbol.assetClass, draft.symbol.exchange) === 'stock'
}

function validateDisplaySize(draft: OrderDraft): OrderPreviewResult | undefined {
  const requested =
    draft.displaySize !== undefined || draft.customFields?.orderVisibility === 'iceberg'
  if (!requested) return undefined

  const reject = (reason: string): OrderPreviewResult => ({
    accepted: false,
    reason,
    fieldErrors: [{ fieldId: 'displaySize', message: reason }],
  })
  if (typeof draft.displaySize !== 'number' || !Number.isFinite(draft.displaySize)) {
    return reject('Displayed quantity is required for an Iceberg order.')
  }
  if (draft.displaySize <= 0 || !Number.isInteger(draft.displaySize)) {
    return reject('Displayed quantity must be a positive whole number of shares.')
  }
  if (draft.displaySize >= draft.quantity) {
    return reject('Displayed quantity must be smaller than total quantity.')
  }
  if (draft.hidden) {
    return reject('Iceberg displayed quantity cannot be combined with a Hidden order.')
  }
  if (
    resolveAssetClass(draft.symbol.assetClass, draft.symbol.exchange) !== 'stock' ||
    draft.symbol.currency?.toUpperCase() !== 'USD' ||
    normalizeStockRoutingExchange(draft.routingDestination ?? draft.symbol.exchange) !== 'SMART'
  ) {
    return reject('Iceberg is supported only for USD stock orders routed through SMART.')
  }
  return undefined
}

function entryReferencePrice(draft: OrderDraft): number {
  return draft.limitPrice ?? draft.stopPrice ?? 0
}

function validOptionExpiration(expiration: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(expiration) || /^\d{8}$/.test(expiration)
}

function orderNeedsLimitPrice(type: OrderType): boolean {
  switch (type) {
    case 'limit':
    case 'stop-limit':
    case 'trailing-stop-limit':
    case 'peg-mid':
    case 'peg-best':
    case 'limit-on-close':
    case 'adaptive':
    case 'ib-algo':
      return true
    default:
      return false
  }
}

function orderNeedsStopPrice(type: OrderType): boolean {
  switch (type) {
    case 'stop':
    case 'stop-limit':
    case 'trailing-stop':
    case 'trailing-stop-limit':
      return true
    default:
      return false
  }
}

function orderNeedsTrailPercent(type: OrderType): boolean {
  return type === 'trailing-stop' || type === 'trailing-stop-limit'
}

function orderTypeDisplayName(type: OrderType): string {
  switch (type) {
    case 'market':
      return 'Market order'
    case 'limit':
      return 'Limit order'
    case 'midprice':
      return 'MIDPRICE order'
    case 'market-to-limit':
      return 'Market-to-limit order'
    case 'stop':
      return 'Stop order'
    case 'stop-limit':
      return 'Stop-limit order'
    case 'trailing-stop':
      return 'Trailing stop order'
    case 'trailing-stop-limit':
      return 'Trailing stop-limit order'
    case 'relative':
      return 'Relative order'
    case 'retail-price-improvement':
      return 'RPI order'
    case 'peg-mid':
      return 'Pegged-to-midpoint order'
    case 'peg-best':
      return 'Pegged-to-best order'
    case 'snap-market':
      return 'Snap-to-market order'
    case 'snap-mid':
      return 'Snap-to-midpoint order'
    case 'snap-primary':
      return 'Snap-to-primary order'
    case 'market-on-close':
      return 'Market-on-close order'
    case 'limit-on-close':
      return 'Limit-on-close order'
    case 'adaptive':
      return 'Adaptive algo order'
    case 'ib-algo':
      return 'IBALGO order'
  }
}
