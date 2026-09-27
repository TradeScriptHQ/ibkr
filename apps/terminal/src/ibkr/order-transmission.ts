import type { TradingOrderStatus } from '@tradescript/pro/sdk'

export const TWS_HELD_MESSAGE = 'Held in TWS — transmission requires attention.'

/** IBKR's blind-trading precaution can leave an API order untransmitted in TWS. */
export function orderTransmissionPresentation(status: TradingOrderStatus, message?: string) {
  const blockedByMarketDataPrecaution =
    /\(354 req \d+\)/.test(message ?? '') &&
    /trying to submit an order without having market data/i.test(message ?? '') &&
    /precautionary settings/i.test(message ?? '')
  const held =
    blockedByMarketDataPrecaution &&
    (status === 'placing' || status === 'pre-submitted' || status === 'inactive')
  const progressed =
    blockedByMarketDataPrecaution &&
    ['working', 'partially-filled', 'filled', 'cancelled', 'expired'].includes(status)
  return {
    status: held ? ('inactive' as const) : status,
    message: held ? `${TWS_HELD_MESSAGE}\n${message}` : progressed ? undefined : message,
    held,
  }
}
