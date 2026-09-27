import type {
  TradingSuggestedQuantityRequest,
  TradingTicketSettingsRequest,
  TradingTicketUserSettings,
} from '@tradescript/pro/sdk'

function orderTicketSettingsKey(request: TradingTicketSettingsRequest): string {
  const symbol = request.symbol
  return `tradescript:ibkr-order-ticket:${request.accountId ?? 'default'}:${symbol?.ticker ?? 'all'}:${symbol?.exchange ?? 'all'}:${symbol?.type ?? 'unknown'}`
}

export function readOrderTicketSettings(
  request: TradingTicketSettingsRequest,
): TradingTicketUserSettings {
  const defaults: TradingTicketUserSettings = { showOrderConfirmations: true }
  if (typeof window === 'undefined') return defaults
  try {
    const stored = window.localStorage.getItem(orderTicketSettingsKey(request))
    return stored ? { ...defaults, ...(JSON.parse(stored) as TradingTicketUserSettings) } : defaults
  } catch {
    return defaults
  }
}

export function writeOrderTicketSettings(
  request: TradingTicketSettingsRequest,
  settings: TradingTicketUserSettings,
): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(orderTicketSettingsKey(request), JSON.stringify(settings))
}

export function suggestedQuantityKey(request: TradingSuggestedQuantityRequest): string {
  return orderTicketSettingsKey(request).replace('order-ticket', 'suggested-quantity')
}

export function readSuggestedQuantity(
  request: TradingSuggestedQuantityRequest,
): number | undefined {
  if (typeof window === 'undefined') return undefined
  const stored = Number(window.localStorage.getItem(suggestedQuantityKey(request)))
  return Number.isFinite(stored) && stored > 0 ? stored : undefined
}

export function writeSuggestedQuantity(
  request: TradingSuggestedQuantityRequest,
  quantity: number,
): void {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Suggested quantity must be greater than zero.')
  }
  if (typeof window === 'undefined') return
  window.localStorage.setItem(suggestedQuantityKey(request), String(quantity))
}
