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
type CleanupLeg = { side: 'buy' | 'sell'; quantity: number }
export function optionCloseDraft<
  TSymbol,
  TOptionLeg extends CleanupLeg = NonNullable<TradingOrderDraft['optionLegs']>[number],
  TStrategyLeg extends CleanupLeg = NonNullable<TradingOrderDraft['strategyLegs']>[number],
>(
  filledQuantity: number,
  draft?: {
    symbol: TSymbol
    side: 'buy' | 'sell'
    quantity: number
    optionLegs?: TOptionLeg[] | undefined
    strategyLegs?: TStrategyLeg[] | undefined
  },
) {
  if (!(filledQuantity > 0)) return undefined
  if (!draft) throw new Error('Missing option cleanup draft')
  const fraction = filledQuantity / draft.quantity
  return {
    symbol: draft.symbol,
    side: reverseSide(draft.side),
    type: 'market' as const,
    quantity: filledQuantity,
    duration: { type: 'day' as const },
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
export function assetCloseDraft<TSymbol>(
  records: readonly Pick<Order, 'side' | 'filledQuantity'>[],
  symbol: TSymbol,
  duration: NonNullable<TradingOrderDraft['duration']> = { type: 'day' },
  quantityStep?: number,
): (Omit<TradingOrderDraft, 'symbol'> & { symbol: TSymbol }) | undefined {
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
    type: 'market' as const,
    quantity: Math.abs(filledDelta),
    duration,
  }
}
