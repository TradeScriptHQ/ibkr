import { describe, expect, it } from 'vitest'
import { toIbOrder } from '../src/ibkr/order-conversion.js'
import { exitChildDrafts } from '../src/ibkr/order-exits.js'
import {
  estimateOrderNotional,
  strategyLegsForDraft,
  strategyOrderQuantity,
} from '../src/ibkr/order-strategy.js'
import { applyOrderPatch, validateDraft } from '../src/ibkr/order-validation.js'
import type { OptionOrderLegDraft, Order, OrderDraft, OrderPatch } from '../src/ibkr/types.js'

const symbol = { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' }
const entry: OrderDraft = {
  accountId: 'paper-test',
  symbol,
  side: 'buy',
  type: 'limit',
  duration: 'day',
  quantity: 2,
  limitPrice: 100,
}

function optionLeg(patch: Partial<OptionOrderLegDraft> = {}): OptionOrderLegDraft {
  return {
    contract: {
      underlying: 'AAPL',
      underlyingSymbolInfo: symbol,
      expiration: '2027-01-15',
      strike: 100,
      right: 'call',
      multiplier: 100,
      currency: 'USD',
    },
    side: 'buy',
    positionEffect: 'open',
    quantity: 2,
    ratio: 1,
    ...patch,
  }
}

function optionDraft(legs: OptionOrderLegDraft[], typedStrategy = false): OrderDraft {
  return {
    ...entry,
    limitPrice: 1.5,
    ...(typedStrategy
      ? { strategyLegs: legs.map((leg) => ({ ...leg, instrument: 'option' as const })) }
      : { optionLegs: legs }),
  }
}

function asOrder(draft: OrderDraft): Order {
  return { ...draft, id: '100', status: 'working', submittedAt: '2026-09-30T12:00:00Z' }
}

describe('option and strategy quantities checked before transmission', () => {
  it.each([false, true])('rejects oversized legs behind a smaller draft (strategy=%s)', (typed) => {
    expect(validateDraft(optionDraft([optionLeg({ quantity: 50 })], typed)).accepted).toBe(false)
  })

  it.each([false, true])('rejects a single leg with a different side (strategy=%s)', (typed) => {
    expect(validateDraft(optionDraft([optionLeg({ side: 'sell' })], typed)).accepted).toBe(false)
  })

  it.each([false, true])('rejects unequal units without explicit ratios (strategy=%s)', (typed) => {
    expect(
      validateDraft(optionDraft([optionLeg(), optionLeg({ side: 'sell', quantity: 6 })], typed))
        .accepted,
    ).toBe(false)
  })

  it.each([false, true])('accepts a 1:3 ratio at two strategy units (strategy=%s)', (typed) => {
    const draft = optionDraft(
      [optionLeg(), optionLeg({ side: 'sell', quantity: 6, ratio: 3 })],
      typed,
    )
    expect(validateDraft(draft).accepted).toBe(true)
    expect(strategyOrderQuantity(strategyLegsForDraft(draft))).toBe(2)
    expect(estimateOrderNotional(draft)).toBe(300)
  })

  it.each([false, true])('rejects noninteger units or ratios (strategy=%s)', (typed) => {
    for (const legs of [
      [optionLeg(), optionLeg({ quantity: 3, ratio: 1.5 })],
      [optionLeg({ quantity: 3, ratio: 2 }), optionLeg({ quantity: 3, ratio: 2 })],
      [optionLeg(), optionLeg({ ratio: 0 })],
      [optionLeg(), optionLeg({ ratio: Number.NaN })],
    ]) {
      expect(validateDraft(optionDraft(legs, typed)).accepted).toBe(false)
    }
  })

  it.each([false, true])(
    'rejects a plain single option with a ratio multiplier (strategy=%s)',
    (typed) => {
      expect(
        validateDraft(optionDraft([optionLeg({ quantity: 4, ratio: 2 })], typed)).accepted,
      ).toBe(false)
    },
  )

  it('accepts matching covered-call contracts and shares at two units', () => {
    const draft: OrderDraft = {
      ...entry,
      side: 'sell',
      limitPrice: 1.5,
      strategyLegs: [
        { ...optionLeg({ side: 'sell', quantity: 4, ratio: 2 }), instrument: 'option' },
        {
          instrument: 'equity',
          symbol: 'AAPL',
          symbolInfo: symbol,
          side: 'buy',
          positionEffect: 'open',
          quantity: 200,
          ratio: 100,
        },
      ],
    }
    expect(validateDraft(draft).accepted).toBe(true)
    expect(strategyOrderQuantity(strategyLegsForDraft(draft))).toBe(2)
    expect(estimateOrderNotional(draft)).toBe(300)
    expect(validateDraft({ ...draft, quantity: 4 }).accepted).toBe(false)
  })
})

describe('resting bracket children obey instrument rules', () => {
  const exits: OrderDraft['exits'] = {
    levels: [
      {
        id: 'L1',
        quantity: 2,
        takeProfit: { price: 110 },
        stopLoss: { kind: 'fixed', triggerPrice: 95 },
      },
    ],
  }

  it.each(['ioc', 'fok', 'opg'] as const)('rejects exits with a %s entry duration', (duration) => {
    expect(validateDraft({ ...entry, duration, exits }).accepted).toBe(false)
  })

  it.each(['day', 'gtc', 'gtd'] as const)('accepts resting %s children', (duration) => {
    const draft = { ...entry, duration, durationDateTime: Date.now() + 60_000, exits }
    expect(validateDraft(draft).accepted).toBe(true)
    expect(exitChildDrafts(draft).every(({ draft: child }) => validateDraft(child).accepted)).toBe(
      true,
    )
  })

  it.each(['fixed', 'trailing'] as const)('rejects unsupported crypto %s exits', (kind) => {
    const draft: OrderDraft = {
      ...entry,
      symbol: { symbol: 'BTC', exchange: 'PAXOS', currency: 'USD', assetClass: 'crypto' },
      exits: {
        levels: [
          {
            id: 'L1',
            quantity: 2,
            stopLoss: kind === 'fixed' ? { kind, triggerPrice: 95 } : { kind, trailingPips: 50 },
          },
        ],
      },
    }
    expect(validateDraft(draft).accepted).toBe(false)
  })

  it('allows a crypto resting limit take-profit without unsupported stops', () => {
    expect(
      validateDraft({
        ...entry,
        symbol: { symbol: 'BTC', exchange: 'PAXOS', currency: 'USD', assetClass: 'crypto' },
        exits: { levels: [{ id: 'L1', quantity: 2, takeProfit: { price: 110 } }] },
      }).accepted,
    ).toBe(true)
  })

  it('rejects fractional futures children although the parent has whole contracts', () => {
    expect(
      validateDraft({
        ...entry,
        symbol: { symbol: 'IBKR:100', exchange: 'CME', currency: 'USD', assetClass: 'futures' },
        exits: { levels: [{ id: 'L1', quantity: 0.5, takeProfit: { price: 110 } }] },
      }).accepted,
    ).toBe(false)
  })
})

describe('trailing distance validation and edits', () => {
  const pipTrail: OrderDraft = {
    ...entry,
    type: 'trailing-stop',
    limitPrice: undefined,
    trailingStopPips: 50,
  }

  it('rejects pip distances and pip edits without an authoritative instrument size', () => {
    for (const draft of [
      pipTrail,
      applyOrderPatch(pipTrail, { trailingStopPips: 60 }),
      applyOrderPatch(pipTrail, { quantity: 1 }),
    ]) {
      expect(validateDraft(draft)).toMatchObject({
        accepted: false,
        reason: expect.stringMatching(/pip size/i),
      })
    }
  })

  it('accepts a percent distance with an optional initial stop', () => {
    expect(
      validateDraft({ ...pipTrail, trailingStopPips: undefined, trailPercent: 2 }).accepted,
    ).toBe(true)
    expect(
      validateDraft({ ...pipTrail, trailingStopPips: undefined, trailPercent: 2, stopPrice: 95 })
        .accepted,
    ).toBe(true)
  })

  it('rejects absent, invalid or competing trail distances', () => {
    for (const patch of [
      { trailingStopPips: undefined },
      { trailingStopPips: 0 },
      { trailingStopPips: Number.NaN },
      { trailPercent: 2 },
      { trailingStopPips: undefined, trailPercent: 0 },
      { stopPrice: -1 },
    ])
      expect(validateDraft({ ...pipTrail, ...patch }).accepted).toBe(false)
  })

  it('switches to percent without a stale pip distance and refuses unsupported pip transmission', () => {
    const percent = applyOrderPatch(pipTrail, { trailPercent: 2 })
    expect(percent.trailingStopPips).toBeUndefined()
    expect(validateDraft(percent).accepted).toBe(true)
    const percentWire = toIbOrder(100, asOrder(percent), true)
    expect(percentWire.trailingPercent).toBe(2)
    expect(percentWire.auxPrice).toBeUndefined()
    const pips = applyOrderPatch(percent, { trailingStopPips: 60 })
    expect(pips.trailPercent).toBeUndefined()
    expect(validateDraft(pips).accepted).toBe(false)
    expect(() => toIbOrder(100, asOrder(pips), true)).toThrow(/pip size/i)
    expect(
      validateDraft(applyOrderPatch(pips, { trailingStopPips: 50, trailPercent: 2 })).accepted,
    ).toBe(false)
  })

  it('retains the percent-only trailing-limit contract and requires an initial price', () => {
    const trailLimit: OrderDraft = {
      ...entry,
      type: 'trailing-stop-limit',
      stopPrice: 100,
      limitPrice: 0.5,
      trailPercent: 2,
    }
    expect(validateDraft(trailLimit).accepted).toBe(true)
    expect(validateDraft({ ...trailLimit, trailingStopPips: 50 }).accepted).toBe(false)
    expect(
      validateDraft({ ...trailLimit, trailPercent: undefined, trailingStopPips: 50 }).accepted,
    ).toBe(false)
    expect(validateDraft({ ...trailLimit, stopPrice: undefined }).accepted).toBe(false)
  })
})

describe('trailing-limit exit prices use the initial stop instead of the limit offset', () => {
  it.each(['buy', 'sell'] as const)(
    'accepts correctly directed %s exits and rejects inverted prices',
    (side) => {
      const draft: OrderDraft = {
        ...entry,
        side,
        type: 'trailing-stop-limit',
        stopPrice: 100,
        limitPrice: 0.5,
        trailPercent: 2,
      }
      const takeProfit = side === 'buy' ? 110 : 90
      const stopLoss = side === 'buy' ? 95 : 105
      const withExits = (tp: number, sl: number): OrderDraft => ({
        ...draft,
        exits: {
          levels: [
            {
              id: 'L1',
              quantity: 2,
              takeProfit: { price: tp },
              stopLoss: { kind: 'fixed', triggerPrice: sl },
            },
          ],
        },
      })
      expect(validateDraft(withExits(takeProfit, stopLoss)).accepted).toBe(true)
      expect(validateDraft(withExits(stopLoss, stopLoss)).accepted).toBe(false)
      expect(validateDraft(withExits(takeProfit, takeProfit)).accepted).toBe(false)
    },
  )
})

describe('OCA edits replace the normalized and raw source consistently', () => {
  const confirmed: OrderDraft = {
    ...entry,
    oca: { groupId: 'original', behavior: 'reduce-with-block' },
    ocaGroup: 'original',
    ocaType: 2,
  }

  it.each([
    { oca: null },
    { oca: { groupId: 'replacement', behavior: 'cancel-with-block' } },
  ] satisfies OrderPatch[])('clears stale raw OCA fields when the selection changes', (patch) => {
    const updated = applyOrderPatch(confirmed, patch)
    expect(updated.ocaGroup).toBeUndefined()
    expect(updated.ocaType).toBeUndefined()
    const sent = toIbOrder(100, asOrder(updated), true)
    expect(sent.ocaGroup).toBe(patch.oca?.groupId)
    expect(sent.ocaType).toBe(patch.oca ? 1 : undefined)
  })

  it('preserves bracket-owned raw OCA groups when only quantity changes', () => {
    const updated = applyOrderPatch({ ...confirmed, oca: undefined }, { quantity: 1 })
    expect(toIbOrder(100, asOrder(updated), true)).toMatchObject({
      ocaGroup: 'original',
      ocaType: 2,
    })
  })
})
