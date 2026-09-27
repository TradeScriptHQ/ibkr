import type { TradingBrokerAdapter, TradingEvent, TradingOrder } from '@tradescript/pro/sdk'
import type { OptionTicketControllerApi } from '@tradescript/pro/sdk/trading'
import { expect, it, vi } from 'vitest'
import {
  followOptionTicketRejections,
  optionTicketRejectionMessage,
} from './option-ticket-rejection.js'

const rejectedOption: TradingOrder = {
  id: '1334',
  accountId: 'DU123',
  symbol: { ticker: 'AAPL', currency: 'USD', type: 'option' },
  side: 'buy',
  type: 'limit',
  status: 'rejected',
  quantity: 1,
  price: 0.48,
  optionLegs: [
    {
      contract: {
        underlying: 'AAPL',
        underlyingSymbolInfo: { ticker: 'AAPL', currency: 'USD', type: 'stock' },
        expiration: '2026-09-09',
        strike: 317.5,
        right: 'call',
        multiplier: 100,
        currency: 'USD',
      },
      side: 'buy',
      positionEffect: 'open',
      quantity: 1,
    },
  ],
  customFields: {
    ibkrOrderRejection: {
      kind: 'price-control',
      boundaryPrice: 0.33,
      referencePrice: 0.08,
      submittedLimitPrice: 0.48,
    },
  },
}

it('formats the IBKR boundary as option premium rather than a percentage or margin', () => {
  expect(optionTicketRejectionMessage(rejectedOption)).toBe(
    'IBKR rejected this option limit as too far from the market. · Allowed limit: below $0.33 premium · IBKR reference: $0.08 · Submitted limit: $0.48',
  )
})

it('shows the matching late rejection in the option ticket even when it arrives first', () => {
  let brokerSubscriber: ((event: TradingEvent) => void) | undefined
  let controllerSubscriber: (() => void) | undefined
  let acceptedOrderId: string | undefined
  const unsubscribeBroker = vi.fn()
  const unsubscribeController = vi.fn()
  const broker = {
    subscribe(callback: (event: TradingEvent) => void) {
      brokerSubscriber = callback
      return unsubscribeBroker
    },
  } satisfies Pick<TradingBrokerAdapter, 'subscribe'>
  const controller = {
    getSnapshot: () => ({ acceptedOrderId }),
    setMessage: vi.fn(),
    subscribe(callback: () => void) {
      controllerSubscriber = callback
      return unsubscribeController
    },
  } as unknown as OptionTicketControllerApi

  const stop = followOptionTicketRejections(broker, controller)
  brokerSubscriber?.({ type: 'orders-history', orders: [rejectedOption] })
  expect(controller.setMessage).not.toHaveBeenCalled()

  acceptedOrderId = '1334'
  controllerSubscriber?.()
  expect(controller.setMessage).toHaveBeenCalledWith(
    'IBKR rejected this option limit as too far from the market. · Allowed limit: below $0.33 premium · IBKR reference: $0.08 · Submitted limit: $0.48',
    false,
  )

  stop()
  expect(unsubscribeBroker).toHaveBeenCalledOnce()
  expect(unsubscribeController).toHaveBeenCalledOnce()
})
