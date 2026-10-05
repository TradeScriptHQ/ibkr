import type { PriceIncrementBand } from '@ibkr-terminal/contracts'
import type { ContractDetails } from '@stoqey/ib'
import { exitChildDrafts } from './order-exits.js'
import type { OrderDraft } from './types.js'

/** Exchange and rule IDs are parallel provider lists; an unmatched route has no authority. */
export function selectedMarketRuleId(
  details: ContractDetails,
  route: string | undefined,
): number | undefined {
  const exchanges = details.validExchanges?.split(',').map((value) => value.trim().toUpperCase())
  const ids = details.marketRuleIds?.split(',').map((value) => Number(value.trim()))
  if (!exchanges?.length || !ids || exchanges.length !== ids.length || !route) return undefined
  const matches = exchanges.flatMap((exchange, index) =>
    exchange === route.trim().toUpperCase() ? [ids[index]] : [],
  )
  if (!matches.length || matches.some((id) => id !== matches[0])) return undefined
  const id = matches[0]
  return Number.isSafeInteger(id) && id! > 0 ? id : undefined
}

/** Reject the entire declaration rather than silently dropping malformed bands. */
export function authoritativePriceIncrements(
  bands: PriceIncrementBand[] | undefined,
): PriceIncrementBand[] | undefined {
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

export function orderHasPricedFields(draft: OrderDraft): boolean {
  return (
    draft.limitPrice !== undefined ||
    draft.stopPrice !== undefined ||
    Boolean(draft.exits?.levels.length)
  )
}

export function orderPriceIncrementRejection(
  draft: OrderDraft,
  bands: PriceIncrementBand[],
): string | undefined {
  const prices: Array<{ label: string; value: number; reference?: number | undefined }> = []
  function collect(order: OrderDraft, label: string) {
    if (order.limitPrice !== undefined)
      prices.push({
        label: `${label} limit price`,
        value: order.limitPrice,
        ...(order.type === 'trailing-stop-limit' ? { reference: order.stopPrice } : {}),
      })
    if (order.stopPrice !== undefined)
      prices.push({ label: `${label} stop price`, value: order.stopPrice })
  }
  collect(draft, 'Order')
  for (const child of exitChildDrafts(draft)) collect(child.draft, `${child.leg} exit`)
  for (const price of prices) {
    if (
      draft.type === 'trailing-stop-limit' &&
      price.label === 'Order limit price' &&
      price.reference === undefined
    )
      return 'IBKR trailing limit-offset price rule is unavailable without an exact stop reference.'
    const reference = price.reference ?? price.value
    const band = bands.findLast((candidate) => candidate.lowEdge <= reference)
    if (!band)
      return `IBKR price increment rule is unavailable at the proposed ${price.label.toLowerCase()}.`
    if (!isExactPriceIncrement(price.value, band.increment))
      return `${price.label} must follow the IBKR price increment ${band.increment} at its proposed price.`
  }
  return undefined
}

/** Decimal input facts avoid binary quotient drift without accepting a fraction of a tick. */
function isExactPriceIncrement(price: number, increment: number): boolean {
  const value = decimalUnits(price)
  const step = decimalUnits(increment)
  const scale = Math.max(value.scale, step.scale)
  const scaledPrice = value.units * 10n ** BigInt(scale - value.scale)
  const scaledStep = step.units * 10n ** BigInt(scale - step.scale)
  return scaledStep > 0n && scaledPrice % scaledStep === 0n
}

function decimalUnits(value: number): { units: bigint; scale: number } {
  const [mantissa = '0', exponent = '0'] = value.toString().toLowerCase().split('e')
  const [whole = '0', fraction = ''] = mantissa.split('.')
  const units = BigInt(`${whole}${fraction}`)
  const scale = fraction.length - Number(exponent)
  return scale < 0 ? { units: units * 10n ** BigInt(-scale), scale: 0 } : { units, scale }
}
