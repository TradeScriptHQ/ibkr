import type { Order } from '@ibkr-terminal/contracts'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'

const reverseSide = (side: 'buy' | 'sell') =>
  side === 'buy' ? ('sell' as const) : ('buy' as const)

/** Subtract only registered close receipts, including partial fills after cancellation. */
export function remainingOwnedFill(
  quantity: number,
  history: Pick<Order, 'id' | 'filledQuantity'>[],
  closingOrderIds: string[],
): number {
  const closed = history
    .filter((order) => closingOrderIds.includes(order.id))
    .reduce((total, order) => total + (order.filledQuantity ?? 0), 0)
  if (closed > quantity) throw new Error('Test close exceeded the owned fill')
  return quantity - closed
}

/** Reverse only the filled fraction, including each leg's ratio and close intent. */
export function optionCloseDraft(
  filledQuantity: number,
  draft?: TradingOrderDraft,
): TradingOrderDraft | undefined {
  if (!(filledQuantity > 0)) return undefined
  if (!draft) throw new Error('Missing option cleanup draft')
  const fraction = filledQuantity / draft.quantity
  return {
    symbol: draft.symbol,
    side: reverseSide(draft.side),
    type: 'market',
    quantity: filledQuantity,
    duration: { type: 'day' },
    ...(draft.optionLegs
      ? {
          optionLegs: draft.optionLegs.map((leg) => ({
            ...leg,
            side: reverseSide(leg.side),
            positionEffect: 'close' as const,
            quantity: leg.quantity * fraction,
          })),
        }
      : {}),
    ...(draft.strategyLegs
      ? {
          strategyLegs: draft.strategyLegs.map((leg) => ({
            ...leg,
            side: reverseSide(leg.side),
            positionEffect: 'close' as const,
            quantity: leg.quantity * fraction,
          })),
        }
      : {}),
  }
}

/** Callers supply only owned orders; existing account positions are never used for sizing. */
export function assetCloseDraft(
  records: readonly Pick<Order, 'side' | 'filledQuantity'>[],
  symbol: TradingOrderDraft['symbol'],
  duration: NonNullable<TradingOrderDraft['duration']> = { type: 'day' },
  quantityStep?: number,
): TradingOrderDraft | undefined {
  const netFills = records.reduce(
    (sum, order) => sum + (order.side === 'buy' ? 1 : -1) * (order.filledQuantity ?? 0),
    0,
  )
  const filledDelta = quantityStep
    ? Number((Math.round(netFills / quantityStep) * quantityStep).toPrecision(12))
    : netFills
  if (filledDelta === 0) return undefined
  return {
    symbol,
    side: filledDelta > 0 ? 'sell' : 'buy',
    type: 'market',
    quantity: Math.abs(filledDelta),
    duration,
  }
}
