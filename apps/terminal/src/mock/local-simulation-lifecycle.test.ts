import type {
  TradingOptionContract,
  TradingOrderContext,
  TradingOrderDraft,
} from '@tradescript/pro/sdk'
import { expect, it } from 'vitest'
import { createLocalSimulation, MOCK_ACCOUNT_ID, MOCK_PROVIDER } from './local-simulation.js'
import { createSyntheticOrderEngine, type SyntheticMarket } from './order-engine.js'

const symbol = {
  ticker: 'AAPL',
  canonicalSymbol: 'mock:AAPL',
  brokerSymbol: 'AAPL',
  provider: MOCK_PROVIDER,
  currency: 'USD',
  type: 'stock' as const,
}
const context: TradingOrderContext = {
  symbol,
  accountId: MOCK_ACCOUNT_ID,
  bid: 199.95,
  ask: 200.05,
  lastPrice: 200,
}
const entry = (quantity = 2): TradingOrderDraft => ({
  symbol,
  side: 'buy',
  type: 'market',
  quantity,
  exits: {
    levels: [
      {
        id: 'protect',
        quantity,
        takeProfit: { price: 210 },
        stopLoss: { kind: 'fixed', triggerPrice: 190 },
      },
    ],
  },
})
const quote = (last: number) => ({ last, bid: last - 0.05, ask: last + 0.05 })

it('advertises implemented bracket capabilities and links exact synthetic children', async () => {
  const simulation = createLocalSimulation()
  expect((await simulation.broker.getFeatures?.())?.supportsBrackets).toBe(true)
  const placed = await simulation.broker.placeOrder(entry(), context)
  const children = (await simulation.broker.getState()).orders.filter(
    (order) => order.parentId === placed.order?.id,
  )
  expect(children).toHaveLength(2)
  expect(children).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'limit',
        side: 'sell',
        quantity: 2,
        price: 210,
        status: 'working',
      }),
      expect.objectContaining({
        type: 'stop',
        stopPrice: 190,
        quantity: 2,
        status: 'working',
      }),
    ]),
  )
  simulation.advanceQuote(symbol, quote(211))
  const state = await simulation.broker.getState()
  expect(state.positions).toEqual([])
  expect(state.orders.find((order) => order.type === 'stop')?.status).toBe('cancelled')
  expect(state.executions).toHaveLength(2)
  expect(state.ordersHistory).toEqual(state.orders)
})

it('activates protection only for filled entry quantity and nets partial target/stop fills', async () => {
  const simulation = createLocalSimulation({ maxFillQuantity: 1 })
  const placed = await simulation.broker.placeOrder(entry(3), context)
  let state = await simulation.broker.getState()
  expect(placed.order).toMatchObject({
    status: 'partially-filled',
    filledQuantity: 1,
    remainingQuantity: 2,
  })
  expect(state.orders.filter((order) => order.parentId)).toEqual(
    expect.arrayContaining([expect.objectContaining({ quantity: 1, remainingQuantity: 1 })]),
  )
  await simulation.broker.cancelOrder?.(placed.order?.id ?? '', context)
  simulation.advanceQuote(symbol, quote(211))
  state = await simulation.broker.getState()
  expect(state.positions).toEqual([])
  expect(state.orders.find((order) => order.type === 'stop')?.status).toBe('cancelled')
  expect(state.executions.map((execution) => execution.quantity)).toEqual([1, 1])
})

it('reduces paired protection on a partial target fill without opening a short position', async () => {
  const simulation = createLocalSimulation()
  await simulation.broker.placeOrder(entry(3), context)
  simulation.advanceQuote(symbol, { ...quote(211), availableQuantity: 1 })
  expect(
    (await simulation.broker.getState()).orders.find((order) => order.type === 'stop'),
  ).toMatchObject({ quantity: 2, remainingQuantity: 2 })
  simulation.advanceQuote(symbol, quote(189))
  const state = await simulation.broker.getState()
  expect(state.positions).toEqual([])
  expect(state.executions.map((execution) => execution.quantity)).toEqual([3, 1, 2])
  expect(state.orders.find((order) => order.type === 'limit')?.status).toBe('cancelled')
})

it('cancels unfilled parent children and applies explicit generic OCA cancellation', async () => {
  const simulation = createLocalSimulation()
  const placed = await simulation.broker.placeOrder(
    { ...entry(), type: 'limit', price: 180 },
    context,
  )
  await simulation.broker.cancelOrder?.(placed.order?.id ?? '', context)
  expect(
    (await simulation.broker.getState()).orders.every((order) => order.status === 'cancelled'),
  ).toBe(true)
  const oca = { groupId: 'pair', behavior: 'cancel-with-block' }
  await simulation.broker.placeOrder(
    { symbol, side: 'buy', type: 'limit', price: 180, quantity: 1, oca },
    context,
  )
  await simulation.broker.placeOrder(
    { symbol, side: 'buy', type: 'stop', stopPrice: 210, quantity: 1, oca },
    context,
  )
  simulation.advanceQuote(symbol, quote(211))
  const state = await simulation.broker.getState()
  expect(
    state.orders.filter((order) => order.oca?.groupId === 'pair').map((order) => order.status),
  ).toEqual(['cancelled', 'filled'])
})

it('keeps stop-limit triggered but unfilled until its limit is executable', async () => {
  const simulation = createLocalSimulation()
  await simulation.broker.placeOrder(
    {
      symbol,
      side: 'buy',
      type: 'stop-limit',
      quantity: 1,
      stopPrice: 210,
      price: 211,
    },
    context,
  )
  simulation.advanceQuote(symbol, quote(220))
  expect((await simulation.broker.getState()).executions).toEqual([])
  simulation.advanceQuote(symbol, quote(209))
  expect((await simulation.broker.getState()).orders[0]).toMatchObject({
    status: 'filled',
    averagePrice: 209.05,
  })
})

it('uses declared synthetic pip units for trailing protection and never a percentage guess', async () => {
  const simulation = createLocalSimulation()
  expect((await simulation.broker.getTradingSymbolInfo?.(context))?.pipSize).toBe(0.01)
  await simulation.broker.placeOrder(
    {
      symbol,
      side: 'sell',
      type: 'trailing-stop',
      quantity: 1,
      trailingStopPips: 100,
    },
    context,
  )
  simulation.advanceQuote(symbol, quote(205))
  simulation.advanceQuote(symbol, quote(203.5))
  expect((await simulation.broker.getState()).orders[0]).toMatchObject({
    status: 'filled',
    averagePrice: 203.45,
  })
})

async function optionPosition(simulation: ReturnType<typeof createLocalSimulation>, quantity = 2) {
  const contract: TradingOptionContract = {
    underlying: 'AAPL',
    underlyingSymbolInfo: symbol,
    expiration: '2026-10-16',
    strike: 200,
    right: 'call',
    multiplier: 100,
    currency: 'USD',
    symbol: 'AAPL-2026-10-16-C-200',
  }
  const resolved = await simulation.broker.resolveOptionContract?.({
    contract,
    accountId: MOCK_ACCOUNT_ID,
  })
  if (!resolved) throw new Error('Missing synthetic option resolution')
  await simulation.broker.placeOrder(
    {
      symbol,
      side: 'buy',
      type: 'market',
      quantity,
      optionLegs: [
        {
          contract: resolved.contract,
          side: 'buy',
          quantity,
          ratio: 1,
          positionEffect: 'open',
          price: 2.5,
        },
      ],
    },
    context,
  )
  const position = (await simulation.broker.getState()).positions[0]
  if (!position) throw new Error('Missing synthetic option position')
  return position
}

it('reverses only the exact registered option using option prices and multiplier', async () => {
  const simulation = createLocalSimulation()
  const position = await optionPosition(simulation)
  await simulation.broker.reversePosition?.(position.id, {
    ...context,
    symbol: position.symbol,
    lastPrice: 999,
  })
  const state = await simulation.broker.getState()
  expect(state.positions).toMatchObject([
    {
      side: 'short',
      quantity: 2,
      averagePrice: 2.49,
      symbol: position.symbol,
      optionContract: position.optionContract,
    },
  ])
  expect(state.executions.map((execution) => [execution.quantity, execution.price])).toEqual([
    [2, 2.5],
    [2, 2.49],
    [2, 2.49],
  ])
  expect(state.orders.slice(1).map((order) => order.optionLegs?.[0]?.positionEffect)).toEqual([
    'close',
    'open',
  ])
  expect(state.accounts[0]?.balance?.cash).toBe(100493)
})

it('waits for a partial option close to complete before opening the reversed side', async () => {
  const simulation = createLocalSimulation({ maxFillQuantity: 1 })
  const initial = await optionPosition(simulation)
  simulation.advanceQuote(initial.symbol, quote(2.5))
  const position = (await simulation.broker.getState()).positions[0]
  if (!position) throw new Error('Missing filled option')
  await simulation.broker.reversePosition?.(position.id, {
    ...context,
    symbol: position.symbol,
  })
  let state = await simulation.broker.getState()
  expect(state.positions).toMatchObject([{ side: 'long', quantity: 1 }])
  expect(
    state.orders.filter((order) => order.optionLegs?.[0]?.positionEffect === 'open'),
  ).toHaveLength(1)
  await expect(simulation.broker.reversePosition?.(position.id, context)).rejects.toThrow(
    'reversal',
  )
  simulation.advanceQuote(position.symbol, quote(2.5))
  state = await simulation.broker.getState()
  expect(state.positions).toEqual([])
  expect(
    state.orders.filter((order) => order.optionLegs?.[0]?.positionEffect === 'open'),
  ).toHaveLength(2)
  simulation.advanceQuote(position.symbol, quote(2.5))
  simulation.advanceQuote(position.symbol, quote(2.5))
  expect((await simulation.broker.getState()).positions).toMatchObject([
    { side: 'short', quantity: 2 },
  ])
})

it('preflights malformed brackets and contradictory option identities without mutations', async () => {
  const simulation = createLocalSimulation()
  await expect(
    simulation.broker.placeOrder(
      {
        ...entry(1),
        exits: {
          levels: [{ id: 'too-large', quantity: 2, takeProfit: { price: 210 } }],
        },
      },
      context,
    ),
  ).rejects.toThrow('exit')
  expect((await simulation.broker.getState()).orders).toEqual([])
  const position = await optionPosition(simulation)
  const contract = position.optionContract
  if (!contract) throw new Error('Missing option')
  const before = await simulation.broker.getState()
  await expect(
    simulation.broker.placeOrder(
      {
        symbol,
        side: 'sell',
        type: 'market',
        quantity: 1,
        optionLegs: [
          {
            contract: { ...contract, strike: 210 },
            side: 'sell',
            quantity: 1,
            ratio: 1,
            positionEffect: 'close',
            price: 3,
          },
        ],
      },
      context,
    ),
  ).rejects.toThrow('identity')
  expect(await simulation.broker.getState()).toEqual(before)
})

it('executes short entry protection in the opposite direction and cancels its target', async () => {
  const simulation = createLocalSimulation()
  const draft = {
    ...entry(),
    side: 'sell' as const,
    exits: {
      levels: [
        {
          id: 'short',
          quantity: 2,
          takeProfit: { price: 190 },
          stopLoss: { kind: 'fixed' as const, triggerPrice: 210 },
        },
      ],
    },
  }
  await simulation.broker.placeOrder(draft, context)
  simulation.advanceQuote(symbol, quote(211))
  const state = await simulation.broker.getState()
  expect(state.positions).toEqual([])
  expect(state.executions.map((execution) => execution.side)).toEqual(['sell', 'buy'])
  expect(state.orders.find((order) => order.parentId && order.type === 'limit')?.status).toBe(
    'cancelled',
  )
})

it('keeps partial manual closes protected for only the remaining owned quantity', async () => {
  const simulation = createLocalSimulation()
  await simulation.broker.placeOrder(entry(3), context)
  const position = (await simulation.broker.getState()).positions[0]
  if (!position) throw new Error('Missing protected position')
  await simulation.broker.closePosition?.(position.id, context, {
    quantity: 1,
  })
  expect((await simulation.broker.getState()).orders.filter((order) => order.parentId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: 'working',
        remainingQuantity: 2,
        quantity: 2,
      }),
    ]),
  )
  simulation.advanceQuote(symbol, quote(211))
  expect((await simulation.broker.getState()).positions).toEqual([])
  expect(
    (await simulation.broker.getState()).executions.map((execution) => execution.quantity),
  ).toEqual([3, 1, 2])
})

it('creates, replaces and removes exact position protection through the public adapter', async () => {
  const simulation = createLocalSimulation()
  await simulation.broker.placeOrder({ symbol, side: 'buy', type: 'market', quantity: 2 }, context)
  const position = (await simulation.broker.getState()).positions[0]
  if (!position) throw new Error('Missing synthetic position')
  const target: TradingOrderDraft = {
    symbol,
    side: 'sell',
    type: 'limit',
    quantity: 2,
    price: 210,
  }
  await simulation.broker.modifyPosition?.(
    position.id,
    {
      takeProfit: target,
      stopLoss: {
        symbol,
        side: 'sell',
        type: 'stop',
        quantity: 2,
        stopPrice: 190,
      },
    },
    context,
  )
  let state = await simulation.broker.getState()
  expect(state.orders.filter((order) => order.parentId === position.id)).toHaveLength(2)
  expect(
    state.orders
      .filter((order) => order.parentId === position.id)
      .every((order) => order.parentType === 'position' && order.status === 'working'),
  ).toBe(true)
  const before = await simulation.broker.getState()
  await expect(
    simulation.broker.modifyPosition?.(
      position.id,
      { takeProfit: { ...target, quantity: 3 } },
      context,
    ),
  ).rejects.toThrow('quantit')
  expect(await simulation.broker.getState()).toEqual(before)
  await simulation.broker.modifyPosition?.(position.id, { stopLoss: null }, context)
  state = await simulation.broker.getState()
  expect(
    state.orders
      .filter((order) => order.type === 'stop')
      .every((order) => order.status === 'cancelled'),
  ).toBe(true)
  simulation.advanceQuote(symbol, quote(211))
  expect((await simulation.broker.getState()).positions).toEqual([])
})

it('applies OCA reduction after partial fills and removes explicit OCA grouping on patch', async () => {
  const simulation = createLocalSimulation({ maxFillQuantity: 1 })
  const oca = { groupId: 'reduce', behavior: 'reduce-with-block' }
  const first = await simulation.broker.placeOrder(
    { symbol, side: 'buy', type: 'limit', quantity: 3, price: 180, oca },
    context,
  )
  await simulation.broker.placeOrder(
    { symbol, side: 'buy', type: 'stop', quantity: 3, stopPrice: 210, oca },
    context,
  )
  simulation.advanceQuote(symbol, quote(211))
  expect((await simulation.broker.getState()).orders[0]).toMatchObject({
    quantity: 2,
    remainingQuantity: 2,
    status: 'working',
  })
  await simulation.broker.modifyOrder?.(first.order?.id ?? '', { oca: null }, context)
  expect((await simulation.broker.getState()).orders[0]?.oca).toBeUndefined()
})

it('updates cumulative average fill prices and marks the shared quote source consistently', async () => {
  const simulation = createLocalSimulation({ maxFillQuantity: 1 })
  await simulation.broker.placeOrder({ symbol, side: 'buy', type: 'market', quantity: 2 }, context)
  simulation.advanceQuote(symbol, quote(210))
  const state = await simulation.broker.getState()
  expect(state.orders[0]).toMatchObject({
    status: 'filled',
    filledQuantity: 2,
    remainingQuantity: 0,
    averagePrice: 205.05,
  })
  expect(state.positions[0]).toMatchObject({
    quantity: 2,
    averagePrice: 205.05,
    marketPrice: 210,
  })
  expect((await simulation.datafeed.getQuotes?.({ symbols: [symbol] }))?.[0]).toMatchObject({
    last: 210,
    bid: 209.95,
    ask: 210.05,
  })
})

it('cancels the exact partial protected entry before reversing its filled position', async () => {
  const simulation = createLocalSimulation({ maxFillQuantity: 1 })
  const placed = await simulation.broker.placeOrder(
    { ...entry(3), type: 'limit', price: 201 },
    context,
  )
  const position = (await simulation.broker.getState()).positions[0]
  if (!position) throw new Error('Missing partial protected position')
  await simulation.broker.reversePosition?.(position.id, context)
  expect(
    (await simulation.broker.getState()).orders.find((order) => order.id === placed.order?.id),
  ).toMatchObject({
    status: 'cancelled',
    filledQuantity: 1,
    remainingQuantity: 0,
  })
  simulation.advanceQuote(symbol, quote(200))
  expect((await simulation.broker.getState()).positions).toMatchObject([
    { side: 'short', quantity: 1 },
  ])
  expect(
    (await simulation.broker.getState()).orders
      .filter((order) => order.parentId)
      .every((order) => order.status === 'cancelled'),
  ).toBe(true)
})

it('rejects runtime side, type and duration values that its capabilities do not support', async () => {
  const simulation = createLocalSimulation()
  for (const patch of [
    { side: 'invalid' },
    { type: 'unknown' },
    { type: 'trailing-stop-limit' },
    { duration: { type: 'ioc' } },
  ]) {
    const invalid = Object.assign(entry(), patch)
    expect(await simulation.broker.previewOrder?.(invalid, context)).toMatchObject({
      accepted: false,
    })
    await expect(simulation.broker.placeOrder(invalid, context)).rejects.toThrow(/synthetic/i)
  }
  expect((await simulation.broker.getState()).orders).toEqual([])
})

it.each([{ side: 'unknown' }, { type: 'unknown' }])(
  'refuses unknown working readback %j before synthetic quote execution mutates state',
  async (unsupported) => {
    const state = await createLocalSimulation().broker.getState()
    let last = 200
    let onQuote: Parameters<SyntheticMarket['subscribe']>[0] | undefined
    const market: SyntheticMarket = {
      quote: (quotedSymbol) => ({
        symbol: quotedSymbol,
        ...quote(last),
        timestamp: 1,
        status: 'ok',
      }),
      subscribe: (listener) => {
        onQuote = listener
        return () => undefined
      },
    }
    const engine = createSyntheticOrderEngine(
      state,
      MOCK_ACCOUNT_ID,
      market,
      new Map(),
      () => 1,
      () => undefined,
    )
    engine.place({ symbol, side: 'buy', type: 'limit', quantity: 1, price: 100 }, context)
    const pending = state.orders[0]
    if (!pending || !onQuote) throw new Error('Missing synthetic working order or listener')
    Object.assign(pending, unsupported)
    const before = structuredClone(state)
    last = 90
    expect(() => onQuote?.(symbol)).toThrow(/synthetic/i)
    expect(state).toEqual(before)
  },
)

it('uses registered option quotes for an unpriced market entry with underlying context', async () => {
  const simulation = createLocalSimulation()
  const position = await optionPosition(simulation, 1)
  const contract = position.optionContract
  if (!contract) throw new Error('Missing exact option')
  const draft: TradingOrderDraft = {
    symbol,
    side: 'buy',
    type: 'market',
    quantity: 1,
    optionLegs: [{ contract, side: 'buy', quantity: 1, ratio: 1, positionEffect: 'open' }],
  }
  const preview = await simulation.broker.previewOrder?.(draft, context)
  expect(preview?.accepted).toBe(true)
  expect(preview?.estimatedMargin).toBeCloseTo(62.75)
  expect((await simulation.broker.placeOrder(draft, context)).order?.averagePrice).toBe(2.51)
})

it('scopes option bulk cancellation to the exact option and rejects unsupported partial reversal', async () => {
  const simulation = createLocalSimulation()
  const position = await optionPosition(simulation, 2)
  const contract = position.optionContract
  if (!contract) throw new Error('Missing exact option')
  const before = await simulation.broker.getState()
  await expect(
    simulation.broker.reversePosition?.(
      position.id,
      { ...context, symbol: position.symbol },
      { quantity: 1 },
    ),
  ).rejects.toThrow('partial reversal')
  expect(await simulation.broker.getState()).toEqual(before)
  await simulation.broker.placeOrder(
    {
      symbol,
      side: 'buy',
      type: 'limit',
      quantity: 1,
      price: 1,
      optionLegs: [
        {
          contract,
          side: 'buy',
          positionEffect: 'open',
          quantity: 1,
          ratio: 1,
        },
      ],
    },
    context,
  )
  expect(await simulation.broker.cancelAllOrders?.({ symbol })).toBe(0)
  expect(await simulation.broker.cancelAllOrders?.({ symbol: position.symbol })).toBe(1)
})
