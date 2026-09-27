import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import { assetCloseDraft, optionCloseDraft, remainingOwnedFill } from './paper-cleanup.js'

const symbol = { ticker: 'AAPL', type: 'stock' as const, currency: 'USD' }

test('close cleanup accounts for partial owned closes and ignores unrelated executions', () => {
  const history = [
    { id: 'owned-close', filledQuantity: 1 },
    { id: 'unrelated', filledQuantity: 100 },
  ]
  assert.equal(remainingOwnedFill(2, history, ['owned-close']), 1)
  assert.equal(remainingOwnedFill(1, history, ['owned-close']), 0)
  assert.throws(() => remainingOwnedFill(0.5, history, ['owned-close']), /exceeded/)
})

// Pure calculations: these tests never connect to a broker or submit orders.
test('stock cleanup reverses only net filled quantity after bracket exits', () => {
  const close = assetCloseDraft(
    [
      { side: 'buy', filledQuantity: 4 },
      { side: 'sell', filledQuantity: 1 },
      { side: 'sell', filledQuantity: 1 },
      { side: 'buy', filledQuantity: 0 },
    ],
    symbol,
  )
  assert.equal(close?.side, 'sell')
  assert.equal(close?.quantity, 2)
  assert.equal(close?.type, 'market')
  assert.equal(
    assetCloseDraft(
      [
        { side: 'buy', filledQuantity: 2 },
        { side: 'sell', filledQuantity: 2 },
      ],
      symbol,
    ),
    undefined,
  )
  assert.equal(assetCloseDraft([], symbol), undefined)
  assert.equal(assetCloseDraft([{ side: 'sell', filledQuantity: 3 }], symbol)?.side, 'buy')
})

test('option cleanup preserves contract identity and reverses partially filled leg ratios', () => {
  const contract = {
    underlying: 'AAPL',
    underlyingSymbolInfo: symbol,
    expiration: '2026-10-16',
    strike: 200,
    right: 'call' as const,
    multiplier: 100,
    currency: 'USD',
  }
  const draft: TradingOrderDraft = {
    symbol,
    side: 'buy',
    type: 'limit',
    quantity: 4,
    price: 1,
    optionLegs: [
      { contract, side: 'buy', quantity: 4, positionEffect: 'open' },
      { contract: { ...contract, strike: 210 }, side: 'sell', quantity: 8, positionEffect: 'open' },
    ],
  }
  const original = structuredClone(draft)
  const close = optionCloseDraft(1, draft)
  assert.equal(close?.quantity, 1)
  assert.equal(close?.side, 'sell')
  assert.equal(close?.type, 'market')
  assert.deepEqual(
    close?.optionLegs?.map((leg) => [leg.side, leg.quantity, leg.positionEffect]),
    [
      ['sell', 1, 'close'],
      ['buy', 2, 'close'],
    ],
  )
  assert.deepEqual(
    close?.optionLegs?.map((leg) => leg.contract),
    draft.optionLegs?.map((leg) => leg.contract),
  )
  assert.deepEqual(draft, original)
})

test('option cleanup needs no draft for an unfilled order, but fails without one after a fill', () => {
  assert.equal(optionCloseDraft(0), undefined)
  assert.throws(() => optionCloseDraft(1), /Missing option cleanup draft/)
})

test('crypto cleanup preserves the actual venue, fractional quantity and IOC duration', () => {
  const crypto = { ticker: 'BTC', type: 'crypto' as const, currency: 'USD', exchange: 'PAXOS' }
  const close = assetCloseDraft(
    [
      { side: 'buy', filledQuantity: 0.002 },
      { side: 'sell', filledQuantity: 0.001 },
    ],
    crypto,
    { type: 'ioc' },
  )
  assert.deepEqual(close, {
    symbol: crypto,
    type: 'market',
    side: 'sell',
    quantity: 0.001,
    duration: { type: 'ioc' },
  })
})

test('crypto cleanup ignores floating-point dust after split exits', () => {
  const crypto = { ticker: 'BTC', type: 'crypto' as const, currency: 'USD', exchange: 'PAXOS' }
  assert.equal(
    assetCloseDraft(
      [
        { side: 'buy', filledQuantity: 0.0003 },
        { side: 'sell', filledQuantity: 0.0001 },
        { side: 'sell', filledQuantity: 0.0002 },
      ],
      crypto,
      { type: 'ioc' },
      1e-8,
    ),
    undefined,
  )
})
