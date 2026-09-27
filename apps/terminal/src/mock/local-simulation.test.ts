import type { TradingOptionContract, TradingOrderContext } from '@tradescript/pro/sdk'
import { describe, expect, it } from 'vitest'
import { createLocalSimulation, MOCK_ACCOUNT_ID, MOCK_PROVIDER } from './local-simulation.js'

const NOW = Date.UTC(2026, 8, 8, 14, 0, 0)
const AAPL = {
  ticker: 'AAPL',
  canonicalSymbol: 'mock:AAPL',
  brokerSymbol: 'AAPL',
  exchange: 'SMART',
  listedExchange: 'NASDAQ',
  currency: 'USD',
  type: 'stock' as const,
  provider: MOCK_PROVIDER,
}
const CONTEXT: TradingOrderContext = {
  accountId: MOCK_ACCOUNT_ID,
  symbol: AAPL,
  currency: 'USD',
  lastPrice: 200,
  bid: 199.95,
  ask: 200.05,
}

describe('local trading simulation', () => {
  it('fills an equity round trip and reconciles cash, positions, orders, and executions', async () => {
    const { broker } = createLocalSimulation({ now: () => NOW })

    const buy = await broker.placeOrder(
      {
        accountId: MOCK_ACCOUNT_ID,
        symbol: AAPL,
        side: 'buy',
        type: 'market',
        quantity: 2,
      },
      CONTEXT,
    )
    expect(buy).toMatchObject({ accepted: true, status: 'accepted' })

    let state = await broker.getState()
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0]).toMatchObject({ side: 'long', quantity: 2, averagePrice: 200.05 })
    expect(state.executions).toHaveLength(1)
    expect(state.accounts[0]?.balance).toMatchObject({ cash: 99_598.9, equity: 99_999 })

    await broker.placeOrder(
      {
        accountId: MOCK_ACCOUNT_ID,
        symbol: AAPL,
        side: 'sell',
        type: 'market',
        quantity: 2,
      },
      CONTEXT,
    )
    state = await broker.getState()
    expect(state.positions).toEqual([])
    expect(state.executions).toHaveLength(2)
    expect(state.orders).toHaveLength(2)
    expect(state.accounts[0]?.balance).toMatchObject({ cash: 99_997.8, equity: 99_997.8 })
  })

  it('fills and closes a single-leg option against the leg mark', async () => {
    const { broker } = createLocalSimulation({ now: () => NOW })
    const contract: TradingOptionContract = {
      underlying: 'AAPL',
      underlyingSymbolInfo: AAPL,
      expiration: '2026-10-16',
      strike: 200,
      right: 'call',
      multiplier: 100,
      currency: 'USD',
      exchange: 'SMART',
      symbol: 'AAPL-2026-10-16-C-200',
    }
    const optionDraft = (
      side: 'buy' | 'sell',
      positionEffect: 'open' | 'close',
      price: number,
    ) => ({
      accountId: MOCK_ACCOUNT_ID,
      symbol: AAPL,
      side,
      type: 'market' as const,
      quantity: 1,
      optionLegs: [{ contract, side, positionEffect, quantity: 1, ratio: 1, price }],
    })

    const preview = await broker.previewOrder?.(optionDraft('buy', 'open', 2.5), CONTEXT)
    expect(preview).toMatchObject({ accepted: true, estimatedMargin: 62.5 })
    await broker.placeOrder(optionDraft('buy', 'open', 2.5), CONTEXT)

    let state = await broker.getState()
    expect(state.positions[0]).toMatchObject({
      side: 'long',
      quantity: 1,
      averagePrice: 2.5,
      optionContract: contract,
    })
    expect(state.accounts[0]?.balance).toMatchObject({ cash: 99_749, equity: 99_999 })

    await broker.placeOrder(optionDraft('sell', 'close', 3), CONTEXT)
    state = await broker.getState()
    expect(state.positions).toEqual([])
    expect(state.executions).toHaveLength(2)
    expect(state.executions[1]?.metadata?.realizedPnl).toBe(50)
    expect(state.accounts[0]?.balance).toMatchObject({ cash: 100_048, equity: 100_048 })
  })

  it('fails closed instead of pretending to execute a multi-leg option strategy', async () => {
    const { broker } = createLocalSimulation({ now: () => NOW })
    const contract: TradingOptionContract = {
      underlying: 'AAPL',
      underlyingSymbolInfo: AAPL,
      expiration: '2026-10-16',
      strike: 200,
      right: 'call',
      multiplier: 100,
      currency: 'USD',
      symbol: 'AAPL-2026-10-16-C-200',
    }
    const leg = {
      contract,
      side: 'buy' as const,
      positionEffect: 'open' as const,
      quantity: 1,
      ratio: 1,
      price: 2.5,
    }
    const draft = {
      accountId: MOCK_ACCOUNT_ID,
      symbol: AAPL,
      side: 'buy' as const,
      type: 'market' as const,
      quantity: 1,
      optionLegs: [leg, { ...leg, id: 'second-leg' }],
    }
    await expect(broker.previewOrder?.(draft, CONTEXT)).resolves.toMatchObject({ accepted: false })
    await expect(broker.placeOrder(draft, CONTEXT)).rejects.toThrow('single-leg options only')
  })

  it('keeps non-market orders working through modify and cancel', async () => {
    const { broker } = createLocalSimulation({ now: () => NOW })
    const result = await broker.placeOrder(
      {
        accountId: MOCK_ACCOUNT_ID,
        symbol: AAPL,
        side: 'buy',
        type: 'limit',
        quantity: 3,
        price: 190,
      },
      CONTEXT,
    )
    expect(result.order).toMatchObject({ status: 'working', price: 190, remainingQuantity: 3 })
    if (!result.order) throw new Error('The simulator did not return its working order')

    const modified = await broker.modifyOrder?.(result.order.id, { price: 191 }, CONTEXT)
    expect(modified).toMatchObject({ status: 'working', price: 191 })
    await broker.cancelOrder?.(result.order.id, CONTEXT)

    const state = await broker.getState()
    expect(state.orders[0]).toMatchObject({ status: 'cancelled', remainingQuantity: 0 })
    expect(state.ordersHistory?.[0]).toMatchObject({
      status: 'cancelled',
      price: 191,
      remainingQuantity: 0,
    })
    expect(state.executions).toEqual([])
  })

  it('publishes deterministic quotes, bars, depth, tape, and option contracts', async () => {
    const { datafeed } = createLocalSimulation({ now: () => NOW })
    const symbol = await datafeed.resolveSymbol?.('AAPL')
    expect(symbol).toMatchObject({ ticker: 'AAPL', provider: MOCK_PROVIDER })
    if (!symbol) throw new Error('The simulator did not resolve AAPL')

    const quotes = await datafeed.getQuotes?.({ symbols: [symbol] })
    expect(quotes?.[0]).toMatchObject({ last: 200, bid: 199.95, ask: 200.05, status: 'ok' })
    const bars = await datafeed.loadBars(symbol, '5m', {
      startTime: NOW - 20 * 300_000,
      endTime: NOW,
      barCount: 20,
    })
    expect(bars.bars).toHaveLength(20)
    expect(
      bars.bars.every((bar, index) => {
        const previous = bars.bars[index - 1]
        return index === 0 || (previous !== undefined && bar.time > previous.time)
      }),
    ).toBe(true)
    const depth = await datafeed.getDepth?.({ symbol, levels: 5 })
    expect(depth?.bids).toHaveLength(5)
    expect(depth?.asks).toHaveLength(5)
    const tape = await datafeed.getTimeAndSales?.({ symbol, limit: 12 })
    expect(tape).toHaveLength(12)
    let streamedTape: unknown
    const unsubscribe = datafeed.subscribeTimeAndSales?.(
      { id: 'test-tape', symbol, limit: 12 },
      (update) => {
        streamedTape = update
      },
    )
    expect(streamedTape).toMatchObject({ symbol, snapshot: true })
    expect((streamedTape as { prints: unknown[] }).prints).toHaveLength(12)
    unsubscribe?.()
    const options = await datafeed.getOptionContracts?.({ symbol })
    expect(options).toMatchObject({ provider: MOCK_PROVIDER, symbol: 'AAPL' })
    expect(options?.contracts).toHaveLength(10)
  })
})
