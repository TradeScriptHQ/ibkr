import { normalizeOptionExpiry } from './contracts.js'
import { positiveNumber, positivePrice } from './numbers.js'
import type {
  BrokerContext,
  OptionOrderLegDraft,
  OrderDraft,
  StrategyOrderLegDraft,
} from './types.js'

export function hasOptionLegs(draft: OrderDraft): boolean {
  return Array.isArray(draft.optionLegs) && draft.optionLegs.length > 0
}

export function hasStrategyLegs(draft: OrderDraft): boolean {
  return Array.isArray(draft.strategyLegs) && draft.strategyLegs.length > 0
}

export function strategyLegsForDraft(draft: OrderDraft): StrategyOrderLegDraft[] {
  if (draft.strategyLegs?.length) return draft.strategyLegs
  return (draft.optionLegs ?? []).map((leg) => ({ ...leg, instrument: 'option' as const }))
}

function estimateReferencePrice(draft: OrderDraft, context: BrokerContext = {}): number {
  const draftPrice = draft.limitPrice ?? draft.stopPrice
  return (
    draftPrice ??
    positiveNumber(context.lastPrice) ??
    positiveNumber(context.bid) ??
    positiveNumber(context.ask) ??
    0
  )
}

export function estimateOrderNotional(
  draft: OrderDraft,
  context: BrokerContext = {},
): number | undefined {
  if (hasStrategyLegs(draft)) {
    const units = strategyOrderQuantity(draft.strategyLegs ?? [])
    const referencePrice = positivePrice(draft.limitPrice)
      ? draft.limitPrice
      : Math.abs(strategyNetUnitPrice(draft.strategyLegs ?? []))
    const multiplier = (draft.strategyLegs ?? []).reduce(
      (max, leg) => (leg.instrument === 'option' ? Math.max(max, leg.contract.multiplier) : max),
      1,
    )
    return units * referencePrice * multiplier
  }
  if (!hasOptionLegs(draft)) {
    const notional = draft.quantity * estimateReferencePrice(draft, context)
    if (['futures', 'option', 'futures-option'].includes(draft.symbol.assetClass ?? '')) {
      const multiplier = positiveNumber(draft.symbol.contractIdentity?.multiplier)
      return multiplier === undefined ? undefined : notional * multiplier
    }
    // Bond face-value and price-factor metadata must be qualified before estimating cost.
    if (draft.symbol.assetClass === 'bond') return undefined
    return notional
  }
  const optionLegs = draft.optionLegs ?? []
  const netPremium = optionLegs.reduce((sum, leg) => {
    const price = leg.price ?? 0
    const ratio = leg.ratio ?? 1
    const signed = leg.side === 'buy' ? 1 : -1
    return sum + signed * price * ratio
  }, 0)
  const contractMultiplier = optionLegs.reduce(
    (max, leg) => Math.max(max, leg.contract.multiplier),
    0,
  )
  const referencePrice = positivePrice(draft.limitPrice) ? draft.limitPrice : Math.abs(netPremium)
  return optionOrderQuantity(optionLegs) * referencePrice * contractMultiplier
}

export function strategyOrderQuantity(legs: StrategyOrderLegDraft[]): number {
  const first = legs[0]
  return first ? first.quantity / (first.ratio ?? 1) : 0
}

function strategyNetUnitPrice(legs: StrategyOrderLegDraft[]): number {
  const multiplier = legs.reduce(
    (max, leg) => (leg.instrument === 'option' ? Math.max(max, leg.contract.multiplier) : max),
    1,
  )
  return legs.reduce((sum, leg) => {
    const signed = leg.side === 'buy' ? 1 : -1
    const price = leg.price ?? 0
    const weight = leg.instrument === 'equity' ? leg.ratio / multiplier : (leg.ratio ?? 1)
    return sum + signed * price * weight
  }, 0)
}

function optionOrderQuantity(optionLegs: OptionOrderLegDraft[]): number {
  return strategyOrderQuantity(optionLegs.map((leg) => ({ ...leg, instrument: 'option' })))
}

export function describeOptionLeg(leg: OptionOrderLegDraft): string {
  const contract = leg.contract
  return `${contract.underlying.toUpperCase()} ${normalizeOptionExpiry(contract.expiration)} ${contract.strike} ${contract.right}`
}
