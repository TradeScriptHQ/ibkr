import type { TradingPosition } from '@tradescript/pro/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { riskPositionInstrumentId } from './risk.js'

afterEach(() => vi.restoreAllMocks())

const stockPosition: TradingPosition = {
  id: 'DUR174991:265598',
  accountId: 'DUR174991',
  symbol: { ticker: 'AAPL', brokerSymbol: 'AAPL', currency: 'USD', type: 'stock' },
  side: 'long',
  quantity: 100,
}

const optionPosition: TradingPosition = {
  id: 'DUR174991:917428525',
  accountId: 'DUR174991',
  symbol: { ticker: 'AAPL', brokerSymbol: 'AAPL', currency: 'USD', type: 'option' },
  optionContract: {
    underlying: 'AAPL',
    underlyingSymbolInfo: {
      ticker: 'AAPL',
      brokerSymbol: 'AAPL',
      currency: 'USD',
      type: 'stock',
    },
    expiration: '2026-09-09',
    strike: 317.5,
    right: 'call',
    multiplier: 100,
    currency: 'USD',
    brokerContractId: 917428525,
  },
  side: 'long',
  quantity: 1,
}

it('keeps stock and option utilization identities unique for the same underlying', () => {
  expect(riskPositionInstrumentId(stockPosition)).toBe('AAPL')
  expect(riskPositionInstrumentId(optionPosition)).toBe('option:917428525')
  expect(new Set([stockPosition, optionPosition].map(riskPositionInstrumentId)).size).toBe(2)
})

it('uses the selected live policy and timestamps decisions after asynchronous quote acquisition', async () => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const { createConnectionRiskAuthority } = await import('./risk.js')
  let policy: unknown
  const sdk = {
    trading: {
      createRiskPolicyController(options: { policy: unknown }) {
        policy = options.policy
        return { destroy() {} }
      },
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[0]
  const broker = {
    async getState() {
      return { accounts: [], positions: [], orders: [], activeAccountId: 'U-test' }
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[1]
  const datafeed = {
    async getQuotes() {
      await Promise.resolve()
      now += 25
      return [{ symbol: stockPosition.symbol, bid: 10, ask: 11, timestamp: Date.now() }]
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[2]
  const limits = {
    maxOrderQuantity: 100,
    maxOrderNotional: 1000,
    maxPositionQuantity: 100,
    maxPositionNotional: 1000,
    maxDailyLoss: 100,
    maxOrdersPerMinute: 10,
    maxEstimatedSlippageBps: 100,
    maxMarketDataAgeMs: 1000,
    maxLeverage: 2,
    maxUnprotectedPositionQuantity: 100,
  }
  const authority = await createConnectionRiskAuthority(
    sdk,
    broker,
    datafeed,
    { enabled: true, autonomyMode: 'paper-auto', allowedAccountIds: ['U-test'], limits },
    'live',
  )
  expect(policy).toMatchObject({ autonomyMode: 'bounded-live-auto', limits })
  const request = await authority.requests.placeOrder?.({
    controlId: 'trading.placeOrder',
    draft: { symbol: stockPosition.symbol, side: 'buy', type: 'limit', quantity: 1, price: 10 },
    context: { symbol: stockPosition.symbol, accountId: 'U-test' },
  })
  expect(request).toMatchObject({
    executionEnvironment: 'live',
    accountId: 'U-test',
    quantity: 1,
    requestedAt: now,
    marketDataAsOf: now,
  })
  authority.destroy()
})
