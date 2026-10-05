import type { TradingOptionContract, TradingOrderContext } from '@tradescript/pro/sdk'
import { expect, it } from 'vitest'
import { createLocalSimulation, MOCK_ACCOUNT_ID, MOCK_PROVIDER } from './local-simulation.js'

const aapl = {
  ticker: 'AAPL',
  canonicalSymbol: 'mock:AAPL',
  brokerSymbol: 'AAPL',
  exchange: 'SMART',
  currency: 'USD',
  type: 'stock' as const,
  provider: MOCK_PROVIDER,
}
const msft = { ...aapl, ticker: 'MSFT', canonicalSymbol: 'mock:MSFT', brokerSymbol: 'MSFT' }
const context: TradingOrderContext = {
  accountId: MOCK_ACCOUNT_ID,
  symbol: aapl,
  lastPrice: 200,
  bid: 200,
  ask: 200,
}
const otherContext: TradingOrderContext = {
  ...context,
  symbol: msft,
  lastPrice: 400,
  bid: 400,
  ask: 400,
}
const now = () => Date.UTC(2026, 8, 30, 12)

it('declares synthetic daily PnL and completed history facts and updates them after commissions', async () => {
  const { broker } = createLocalSimulation({ now })
  const initial = await broker.getState()
  expect(initial.accounts[0]?.customFields).toMatchObject({
    provider: MOCK_PROVIDER,
    synthetic: true,
    dailyPnl: 0,
  })
  expect(initial.ordersHistory).toEqual([])
  await broker.placeOrder({ symbol: aapl, side: 'buy', type: 'market', quantity: 1 }, context)
  const filled = await broker.getState()
  expect(filled.accounts[0]?.customFields?.dailyPnl).toBe(-1)
  expect(filled.ordersHistory).toHaveLength(1)
})

it('quotes only broker-resolved exact synthetic option identities instead of stock/default prices', async () => {
  const { broker, datafeed } = createLocalSimulation({ now })
  const contract: TradingOptionContract = {
    underlying: 'AAPL',
    underlyingSymbolInfo: aapl,
    expiration: '2026-10-16',
    strike: 200,
    right: 'call',
    multiplier: 100,
    currency: 'USD',
    exchange: 'SMART',
    symbol: 'AAPL-2026-10-16-C-200',
  }
  const resolved = await broker.resolveOptionContract?.({ contract, accountId: MOCK_ACCOUNT_ID })
  if (!resolved) throw new Error('Synthetic option resolution missing')
  const contractId = resolved.contract.brokerContractId
  if (contractId === undefined) throw new Error('Exact synthetic contract identifier missing')
  expect(resolved.contract).toMatchObject({
    brokerContractId: contract.symbol,
    route: 'LOCAL',
    customFields: { provider: MOCK_PROVIDER, synthetic: true },
  })
  const symbol = {
    ticker: contract.symbol ?? '',
    brokerSymbol: String(resolved.contract.brokerContractId),
    canonicalSymbol: `mock-option:${String(resolved.contract.brokerContractId)}`,
    exchange: 'LOCAL',
    currency: 'USD',
    type: 'option' as const,
    provider: MOCK_PROVIDER,
  }
  expect((await datafeed.getQuotes?.({ symbols: [symbol] }))?.[0]).toMatchObject({
    symbol,
    status: 'ok',
    last: 2.5,
    bid: 2.49,
    ask: 2.51,
  })
  const foreign = { ...symbol, brokerSymbol: 'unknown', canonicalSymbol: 'mock-option:unknown' }
  expect((await datafeed.getQuotes?.({ symbols: [foreign] }))?.[0]).toMatchObject({
    status: 'unavailable',
  })
  expect(
    (await broker.getTradingSymbolInfo?.({ symbol: foreign }))?.contractMultiplier,
  ).toBeUndefined()
  await expect(
    broker.resolveOptionContract?.({
      contract: { ...contract, brokerContractId: contractId, strike: 210 },
    }),
  ).rejects.toThrow('conflicts')
})

it('restricts bulk cancellation to exact account and instrument scope', async () => {
  const { broker } = createLocalSimulation({ now })
  await broker.placeOrder(
    {
      symbol: aapl,
      type: 'limit',
      side: 'buy',
      quantity: 1,
      price: 190,
      accountId: MOCK_ACCOUNT_ID,
    },
    context,
  )
  await broker.placeOrder(
    {
      symbol: msft,
      type: 'limit',
      side: 'buy',
      quantity: 1,
      price: 390,
      accountId: MOCK_ACCOUNT_ID,
    },
    otherContext,
  )
  expect(await broker.cancelAllOrders?.({ accountId: 'different-test-account' })).toBe(0)
  expect(await broker.cancelAllOrders?.({ accountId: MOCK_ACCOUNT_ID, symbol: aapl })).toBe(1)
  expect(
    (await broker.getState()).orders.map((order) => [order.symbol.ticker, order.status]),
  ).toEqual([
    ['AAPL', 'cancelled'],
    ['MSFT', 'working'],
  ])
})

it('restricts flatten to exact account and instrument scope', async () => {
  const { broker } = createLocalSimulation({ now })
  await broker.placeOrder({ symbol: aapl, type: 'market', side: 'buy', quantity: 1 }, context)
  await broker.placeOrder({ symbol: msft, type: 'market', side: 'buy', quantity: 1 }, otherContext)
  expect(await broker.flattenPositions?.([context], { accountId: 'different-test-account' })).toBe(
    0,
  )
  expect(
    await broker.flattenPositions?.([context], { symbol: aapl, accountId: MOCK_ACCOUNT_ID }),
  ).toBe(1)
  expect((await broker.getState()).positions).toMatchObject([
    { symbol: { ticker: 'MSFT' }, quantity: 1 },
  ])
})

it('preflights every flatten price context before changing any simulated position', async () => {
  const { broker } = createLocalSimulation({ now })
  await broker.placeOrder({ symbol: aapl, type: 'market', side: 'buy', quantity: 1 }, context)
  await broker.placeOrder({ symbol: msft, type: 'market', side: 'buy', quantity: 1 }, otherContext)
  const before = await broker.getState()
  await expect(broker.flattenPositions?.([context])).rejects.toThrow('context')
  expect(await broker.getState()).toEqual(before)
})

it('advertises protective brackets only after accepting and linking native synthetic children', async () => {
  const { broker } = createLocalSimulation({ now })
  const draft = {
    symbol: aapl,
    type: 'market' as const,
    side: 'buy' as const,
    quantity: 1,
    exits: {
      levels: [
        { id: 'test-exit', quantity: 1, stopLoss: { kind: 'fixed' as const, triggerPrice: 190 } },
      ],
    },
  }
  expect((await broker.getFeatures?.())?.supportsBrackets).toBe(true)
  expect((await broker.getTradingSymbolInfo?.(context))?.supportsMarketBrackets).toBe(true)
  expect((await broker.getState()).accounts[0]?.capabilities?.supportsMarketBrackets).toBe(true)
  expect(await broker.previewOrder?.(draft, context)).toMatchObject({ accepted: true })
  const placed = await broker.placeOrder(draft, context)
  expect((await broker.getState()).orders).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        parentId: placed.order?.id,
        type: 'stop',
        status: 'working',
        quantity: 1,
      }),
    ]),
  )
})

it.each([-1, 0, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects invalid partial-close quantity %s before mutation',
  async (quantity) => {
    const { broker } = createLocalSimulation({ now })
    await broker.placeOrder({ symbol: aapl, type: 'market', side: 'buy', quantity: 2 }, context)
    const before = await broker.getState()
    const id = before.positions[0]?.id
    if (!id) throw new Error('Synthetic position missing')
    await expect(broker.closePosition?.(id, context, { quantity })).rejects.toThrow('quantity')
    expect(await broker.getState()).toEqual(before)
  },
)

it('keeps modified working-order quantity and remaining quantity consistent', async () => {
  const { broker } = createLocalSimulation({ now })
  const placed = await broker.placeOrder(
    { symbol: aapl, type: 'limit', side: 'buy', quantity: 3, price: 190 },
    context,
  )
  const id = placed.order?.id
  if (!id) throw new Error('Synthetic order missing')
  expect(await broker.modifyOrder?.(id, { quantity: 4 }, context)).toMatchObject({
    quantity: 4,
    filledQuantity: 0,
    remainingQuantity: 4,
  })
  expect((await broker.getState()).ordersHistory?.[0]).toMatchObject({
    quantity: 4,
    remainingQuantity: 4,
  })
})

it('rejects an invalid quantity patch without changing the working order', async () => {
  const { broker } = createLocalSimulation({ now })
  const placed = await broker.placeOrder(
    { symbol: aapl, type: 'limit', side: 'buy', quantity: 3, price: 190 },
    context,
  )
  const id = placed.order?.id
  if (!id) throw new Error('Synthetic order missing')
  const before = await broker.getState()
  await expect(broker.modifyOrder?.(id, { quantity: -1 }, context)).rejects.toThrow('quantity')
  expect(await broker.getState()).toEqual(before)
})

it('calculates synthetic margin from gross long and short exposure', async () => {
  const { broker } = createLocalSimulation({ now })
  await broker.placeOrder({ symbol: aapl, type: 'market', side: 'buy', quantity: 2 }, context)
  await broker.placeOrder({ symbol: msft, type: 'market', side: 'sell', quantity: 1 }, otherContext)
  expect((await broker.getState()).accounts[0]?.balance?.marginUsed).toBe(200)
})

it('derives each synthetic percentage change from its own previous close', async () => {
  const { datafeed } = createLocalSimulation({ now })
  const quote = (await datafeed.getQuotes?.({ symbols: [msft] }))?.[0]
  expect(quote?.changePercent).toBeCloseTo((1.25 / 418.75) * 100, 8)
})

it('rejects unsupported option reversal without creating phantom exposure', async () => {
  const { broker } = createLocalSimulation({ now })
  const contract: TradingOptionContract = {
    underlying: 'AAPL',
    underlyingSymbolInfo: aapl,
    expiration: '2026-10-16',
    strike: 200,
    right: 'call',
    multiplier: 100,
    currency: 'USD',
    symbol: 'test-option',
  }
  await broker.placeOrder(
    {
      symbol: aapl,
      type: 'market',
      side: 'buy',
      quantity: 1,
      optionLegs: [
        { contract, side: 'buy', positionEffect: 'open', quantity: 1, ratio: 1, price: 2 },
      ],
    },
    context,
  )
  const before = await broker.getState()
  const position = before.positions[0]
  if (!position) throw new Error('Synthetic option position missing')
  await expect(
    broker.reversePosition?.(position.id, { ...context, symbol: position.symbol, lastPrice: 2 }),
  ).rejects.toThrow('option reversal')
  expect(await broker.getState()).toEqual(before)
})
