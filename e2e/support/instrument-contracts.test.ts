import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MarketSymbol } from '@ibkr-terminal/contracts'
import type { APIRequestContext, APIResponse } from '@playwright/test'
import { resolveUsStock } from './instrument-contracts.js'

const exact: MarketSymbol = {
  ticker: 'AAPL',
  type: 'stock',
  exchange: 'SMART',
  primaryExchange: 'NASDAQ',
  currency: 'USD',
  canonicalSymbol: 'IBKR:101',
  contractIdentity: { conId: 101, securityType: 'STK' },
}
function client(symbol: MarketSymbol) {
  const request = {
    async get(url: string) {
      const params = new URL(url, 'http://localhost:3000').searchParams
      assert.equal(params.get('assetClass'), 'stock')
      assert.equal(params.get('exchange'), 'SMART')
      assert.equal(params.get('primaryExchange'), 'NASDAQ')
      assert.equal(params.get('currency'), 'USD')
      return {
        status: () => 200,
        url: () => 'http://localhost:3000/api/v1/ibkr/symbols/resolve',
        headers: () => ({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
        json: async () => symbol,
      } as unknown as APIResponse
    },
  } as unknown as APIRequestContext
  return request
}

test('native stock picker retains exactly the provider-qualified listing', async () => {
  assert.strictEqual(await resolveUsStock(client(exact), 'AAPL'), exact)
})

test('stock picker refuses a different ticker, listing, currency or instrument class', async () => {
  for (const extra of [
    { ticker: 'MSFT' },
    { primaryExchange: 'FOREIGN' },
    { currency: 'EUR' },
    { exchange: 'FOREIGN' },
    { type: 'cfd' as const },
  ])
    await assert.rejects(
      resolveUsStock(client({ ...exact, ...extra }), 'AAPL'),
      /exact requested US stock identity/u,
    )
})

test('stock picker cannot infer absent or contradictory native identity', async () => {
  for (const extra of [
    { canonicalSymbol: undefined },
    { canonicalSymbol: 'AAPL' },
    { contractIdentity: { conId: 102, securityType: 'STK' } },
    { contractIdentity: { conId: 101, securityType: 'OPT' } },
  ])
    await assert.rejects(
      resolveUsStock(client({ ...exact, ...extra }), 'AAPL'),
      /exact requested US stock identity/u,
    )
})
