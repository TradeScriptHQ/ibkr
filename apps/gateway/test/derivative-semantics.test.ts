import { SecType } from '@stoqey/ib'
import { describe, expect, it } from 'vitest'
import { fromIbSymbol, toIbOptionContract } from '../src/ibkr/contracts.js'
import { fromIbPosition } from '../src/ibkr/order-conversion.js'
import { estimateOrderNotional } from '../src/ibkr/order-strategy.js'
import { validateDraft } from '../src/ibkr/order-validation.js'
import type { OrderDraft } from '../src/ibkr/types.js'

const future = fromIbSymbol({
  symbol: 'MES',
  conId: 123,
  secType: SecType.FUT,
  currency: 'USD',
  exchange: 'CME',
  multiplier: 5,
})
const draft: OrderDraft = {
  symbol: { ...future, symbol: 'IBKR:123' },
  side: 'buy',
  type: 'limit',
  duration: 'day',
  quantity: 2,
  limitPrice: 6000,
}

describe('derivative contract mechanics', () => {
  it('uses the broker future multiplier and leaves an unavailable notional unknown', () => {
    expect(estimateOrderNotional(draft)).toBe(60000)
    expect(
      estimateOrderNotional({ ...draft, symbol: { ...draft.symbol, contractIdentity: undefined } }),
    ).toBeUndefined()
  })
  it('keeps derivative average cost separate from the price per quoted unit', () => {
    const contract = { symbol: 'MES', secType: SecType.FUT, conId: 123, multiplier: 5 }
    expect(fromIbPosition('paper-test', contract, 2, 30000)).toMatchObject({
      avgCost: 30000,
      averagePrice: 6000,
    })
    expect(
      fromIbPosition('paper-test', { symbol: 'MES', secType: SecType.FUT, conId: 123 }, 2, 30000)
        .averagePrice,
    ).toBeUndefined()
  })
  it('validates an option underlying by exact broker identity across display and execution symbols', () => {
    const option = {
      underlying: 'MES',
      underlyingSymbolInfo: future,
      expiration: '2026-12-18',
      strike: 6000,
      right: 'call' as const,
      multiplier: 5,
      exchange: 'CME',
      currency: 'USD',
      brokerContractId: 456,
    }
    const order = {
      ...draft,
      limitPrice: 10,
      optionLegs: [{ contract: option, side: 'buy' as const, quantity: 2 }],
    }
    expect(validateDraft(order).accepted).toBe(true)
    expect(
      validateDraft({
        ...order,
        symbol: {
          ...draft.symbol,
          canonicalSymbol: 'IBKR:999',
          contractIdentity: { ...future.contractIdentity!, conId: 999 },
          symbol: 'IBKR:999',
        },
      }).accepted,
    ).toBe(false)
    expect(toIbOptionContract(option)).toMatchObject({
      symbol: 'MES',
      secType: SecType.FOP,
      conId: 456,
      multiplier: 5,
    })
  })
  it('does not let typed option legs bypass ForecastEx buy-only rules', () => {
    expect(
      validateDraft({
        ...draft,
        symbol: { symbol: 'FF', assetClass: 'stock', currency: 'USD' },
        optionLegs: [
          {
            side: 'sell',
            quantity: 1,
            contract: {
              underlying: 'FF',
              underlyingSymbolInfo: { symbol: 'FF' },
              expiration: '2026-12-18',
              right: 'call',
              strike: 3.375,
              multiplier: 1,
              exchange: 'FORECASTX',
            },
          },
        ],
      }).accepted,
    ).toBe(false)
  })

  it('enforces ForecastEx buy-only whole contracts and its price and duration boundaries', () => {
    const event = {
      ...draft,
      symbol: {
        symbol: 'IBKR:456',
        exchange: 'FORECASTX',
        currency: 'USD',
        assetClass: 'event-contract',
      },
      quantity: 1,
      limitPrice: 0.5,
    }
    expect(validateDraft(event).accepted).toBe(true)
    for (const patch of [
      { side: 'sell' as const },
      { type: 'market' as const },
      { quantity: 0.5 },
      { limitPrice: 1 },
      { limitPrice: 0 },
      { duration: 'fok' as const },
    ])
      expect(validateDraft({ ...event, ...patch }).accepted).toBe(false)
  })
})
