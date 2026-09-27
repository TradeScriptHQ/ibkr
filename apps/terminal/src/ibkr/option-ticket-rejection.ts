import type { TradingBrokerAdapter, TradingOrder } from '@tradescript/pro/sdk'
import type { OptionTicketControllerApi } from '@tradescript/pro/sdk/trading'

interface IbkrPriceControlRejection {
  readonly kind: 'price-control'
  readonly boundaryPrice: number
  readonly referencePrice: number
  readonly submittedLimitPrice?: number | undefined
}

function priceControlRejection(order: TradingOrder): IbkrPriceControlRejection | undefined {
  const value = order.customFields?.ibkrOrderRejection
  if (value === null || typeof value !== 'object') return undefined
  const rejection = value as Partial<IbkrPriceControlRejection>
  if (
    rejection.kind !== 'price-control' ||
    !Number.isFinite(rejection.boundaryPrice) ||
    !Number.isFinite(rejection.referencePrice)
  ) {
    return undefined
  }
  return rejection as IbkrPriceControlRejection
}

function optionCurrency(order: TradingOrder): string {
  const optionLeg = order.optionLegs?.[0]
  if (optionLeg?.contract.currency) return optionLeg.contract.currency
  for (const leg of order.strategyLegs ?? []) {
    if (leg.instrument === 'option' && leg.contract.currency) return leg.contract.currency
  }
  return order.symbol.currency ?? 'USD'
}

function formatPremium(currency: string, value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)
}

function isOptionOrder(order: TradingOrder): boolean {
  return Boolean(
    order.optionLegs?.length || order.strategyLegs?.some((leg) => leg.instrument === 'option'),
  )
}

export function optionTicketRejectionMessage(order: TradingOrder): string | undefined {
  if (order.status !== 'rejected' || !isOptionOrder(order)) return undefined
  const rejection = priceControlRejection(order)
  if (!rejection) return order.message
  const currency = optionCurrency(order)
  const direction = order.side === 'buy' ? 'below' : 'above'
  const parts = [
    'IBKR rejected this option limit as too far from the market.',
    `Allowed limit: ${direction} ${formatPremium(currency, rejection.boundaryPrice)} premium`,
    `IBKR reference: ${formatPremium(currency, rejection.referencePrice)}`,
  ]
  const submittedLimitPrice = rejection.submittedLimitPrice ?? order.price
  if (submittedLimitPrice !== undefined) {
    parts.push(`Submitted limit: ${formatPremium(currency, submittedLimitPrice)}`)
  }
  return parts.join(' · ')
}

/** Keep a submitted option ticket attached to the broker's eventual rejection outcome. */
export function followOptionTicketRejections(
  broker: Pick<TradingBrokerAdapter, 'subscribe'>,
  controller: OptionTicketControllerApi,
): () => void {
  let historicalOrders: TradingOrder[] = []
  let shownOrderId: string | undefined

  const publishMatchingRejection = () => {
    const acceptedOrderId = controller.getSnapshot().acceptedOrderId
    if (!acceptedOrderId || acceptedOrderId === shownOrderId) return
    const order = historicalOrders.find((candidate) => candidate.id === acceptedOrderId)
    if (!order) return
    const message = optionTicketRejectionMessage(order)
    if (!message) return
    shownOrderId = acceptedOrderId
    controller.setMessage(message, false)
  }

  const unsubscribeBroker = broker.subscribe?.((event) => {
    if (event.type !== 'orders-history') return
    historicalOrders = event.orders
    publishMatchingRejection()
  })
  const unsubscribeController = controller.subscribe(() => publishMatchingRejection())

  return () => {
    unsubscribeBroker?.()
    unsubscribeController()
  }
}
