import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MarketQuote, OrderDraft } from '@ibkr-terminal/contracts'
import type { APIRequestContext, APIResponse } from '@playwright/test'
import { exactLiveFamilyQuote, placeFamilyOrder } from './paper-family-orders.js'
import type { TerminalSession } from './session.js'

const draft: OrderDraft = {
  symbol: {
    symbol: 'IBKR:101',
    canonicalSymbol: 'IBKR:101',
    exchange: 'SMART',
    currency: 'USD',
    assetClass: 'cfd',
    contractIdentity: { conId: 101, securityType: 'CFD' },
  },
  side: 'buy',
  type: 'market',
  quantity: 1,
  duration: 'day',
}
const session: TerminalSession = {
  csrfToken: 'synthetic-csrf',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  mutationHeaders: { 'x-tradescript-connection': 'synthetic-paper-generation' },
}
function quote(extra: Partial<MarketQuote> = {}): MarketQuote {
  const timestamp = new Date().toISOString()
  return {
    symbol: draft.symbol,
    bid: 100,
    ask: 101,
    timestamp,
    bidUpdatedAt: timestamp,
    askUpdatedAt: timestamp,
    marketDataType: 'live',
    status: 'ok',
    ...extra,
  }
}
function client(quotes: MarketQuote[][]) {
  const writes: string[] = []
  let reads = 0
  const response = (body: unknown): APIResponse =>
    ({
      status: () => 200,
      url: () => 'http://localhost:3000/api/v1/ibkr/test-owned-fixture',
      headers: () => ({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
      json: async () => body,
    }) as unknown as APIResponse
  const request = {
    async get() {
      return response(quotes[Math.min(reads++, quotes.length - 1)])
    },
    async post(url: string) {
      writes.push(url)
      return response(
        url.endsWith('/preview')
          ? { accepted: true, confirmId: 'synthetic-preview' }
          : { order: { id: 'test-owned-receipt' } },
      )
    },
  } as unknown as APIRequestContext
  return { request, writes }
}

for (const [name, invalid] of [
  ['provider 10197', () => quote({ status: 'unavailable', ibkrErrorCode: 10197 })],
  ['delayed data', () => quote({ status: 'delayed', marketDataType: 'delayed' })],
  ['stale bid', () => quote({ bidUpdatedAt: new Date(Date.now() - 60_000).toISOString() })],
  [
    'different native contract',
    () =>
      quote({ symbol: { ...draft.symbol, contractIdentity: { conId: 102, securityType: 'CFD' } } }),
  ],
] as const) {
  test(`market family placement refuses ${name} before any preview or dispatch`, async () => {
    const { request, writes } = client([[invalid()]])
    await assert.rejects(placeFamilyOrder(request, session, draft), /paper market precondition/iu)
    assert.deepEqual(writes, [])
  })
}

test('a quote lost during native preview blocks placement after preview', async () => {
  const { request, writes } = client([
    [quote()],
    [quote({ status: 'unavailable', ibkrErrorCode: 10197 })],
  ])
  await assert.rejects(placeFamilyOrder(request, session, draft), /paper market precondition/iu)
  assert.deepEqual(writes, ['/api/v1/ibkr/orders/preview'])
})

test('a passive lifecycle limit also requires fresh live facts before preview', async () => {
  const { request, writes } = client([[quote({ status: 'unavailable', ibkrErrorCode: 10197 })]])
  await assert.rejects(
    placeFamilyOrder(request, session, { ...draft, type: 'limit', limitPrice: 90 }),
    /paper market precondition/iu,
  )
  assert.deepEqual(writes, [])
})

test('exact fresh live entry and opposite cleanup use paper generation and preview binding', async () => {
  for (const side of ['buy', 'sell'] as const) {
    const { request, writes } = client([[quote()]])
    assert.equal(await placeFamilyOrder(request, session, { ...draft, side }), 'test-owned-receipt')
    assert.deepEqual(writes, ['/api/v1/ibkr/orders/preview', '/api/v1/ibkr/orders'])
  }
})

test('the declared quote HTTP descriptor proves its exact requested native ID without extra terms', () => {
  const exact = quote({
    symbol: {
      symbol: 'IBKR:101',
      assetClass: 'cfd',
      exchange: 'SMART',
      currency: 'USD',
    },
  })
  assert.strictEqual(exactLiveFamilyQuote(draft.symbol, [exact]), exact)
})

test('unqualified or ambiguous quote descriptors cannot authorize family placement', () => {
  for (const quotes of [
    [],
    [quote(), quote()],
    [quote({ symbol: { ...draft.symbol, currency: 'EUR' } })],
    [quote({ symbol: { ...draft.symbol, exchange: 'FOREIGN' } })],
    [quote({ symbol: { ...draft.symbol, assetClass: 'commodity' } })],
    [quote({ symbol: { ...draft.symbol, symbol: 'IBKR:102', canonicalSymbol: 'IBKR:102' } })],
    [quote({ symbol: { ...draft.symbol, contractIdentity: { conId: 101, securityType: 'STK' } } })],
  ])
    assert.throws(() => exactLiveFamilyQuote(draft.symbol, quotes), /paper market precondition/iu)
})

test('missing, stale or future side observations and crossed prices refuse execution', () => {
  for (const extra of [
    { bidUpdatedAt: undefined },
    { askUpdatedAt: undefined },
    { askUpdatedAt: 'invalid' },
    { askUpdatedAt: new Date(Date.now() - 30_000).toISOString() },
    { timestamp: new Date(Date.now() + 60_000).toISOString() },
    { bid: Number.NaN },
    { ask: 0 },
    { ask: 99 },
    { marketDataType: 'frozen' as const },
    { marketDataType: undefined },
    { status: undefined },
  ])
    assert.throws(
      () => exactLiveFamilyQuote(draft.symbol, [quote(extra)]),
      /paper market precondition/iu,
    )
})

test('native terms and classification must agree with the qualified caller target', () => {
  const warrant = {
    ...draft.symbol,
    assetClass: 'warrant',
    contractIdentity: {
      conId: 101,
      securityType: 'WAR',
      expiry: '20261218',
      strike: 100,
      right: 'C',
    },
  }
  assert.throws(
    () =>
      exactLiveFamilyQuote(warrant, [
        quote({
          symbol: { ...warrant, contractIdentity: { ...warrant.contractIdentity, strike: 101 } },
        }),
      ]),
    /contradicts retained native/iu,
  )
  assert.throws(
    () => exactLiveFamilyQuote({ ...draft.symbol, assetClass: 'stock' }, [quote()]),
    /missing or contradictory exact native/iu,
  )
})
