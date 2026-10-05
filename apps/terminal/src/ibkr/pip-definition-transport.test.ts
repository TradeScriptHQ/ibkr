import type { ContractPipDefinition } from '@ibkr-terminal/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { toTradingState } from './broker-mapping.js'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter.js'
import type { BackendState } from './types.js'

afterEach(() => vi.unstubAllGlobals())
const fact: ContractPipDefinition = {
  conId: 101,
  securityType: 'FUT',
  currency: 'USD',
  pipSize: 0.5,
  unit: 'quote-price-per-pip',
  source: 'approved-contract-catalog',
  reference: 'synthetic-fixture:unit-transport',
}

it('uses provider pip metadata separately from tick schedules and monetary pip value', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        symbol: {
          minTick: 0.25,
          priceIncrements: [{ lowEdge: 0, increment: 0.25 }],
          pipDefinition: fact,
        },
        metadata: {
          minQuantity: 1,
          quantityStep: 1,
          contractMultiplier: 50,
          orderTypes: 'MKT,LMT,TRAIL',
        },
      }),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const context = {
    symbol: {
      ticker: 'ESZ6',
      canonicalSymbol: 'IBKR:101',
      brokerSymbol: 'IBKR:101',
      currency: 'USD',
      exchange: 'CME',
      type: 'futures' as const,
    },
  }
  const info = await broker.getTradingSymbolInfo?.(context)
  expect(info).toMatchObject({
    priceIncrements: [{ lowEdge: 0, increment: 0.25 }],
    pipSize: 0.5,
    contractMultiplier: 50,
    supportsTrailingStop: true,
  })
  expect(info?.pipValue).toBeUndefined()
  const values: Array<number | undefined> = []
  broker.subscribePipValue?.({ symbol: context.symbol }, (value) => values.push(value))
  expect(values).toEqual([undefined])
})

it('preserves approved pip display units on order and position readback', () => {
  const symbol = {
    symbol: 'IBKR:101',
    canonicalSymbol: 'IBKR:101',
    assetClass: 'futures',
    currency: 'USD',
    exchange: 'CME',
    contractIdentity: { conId: 101, securityType: 'FUT' },
    pipDefinition: fact,
  }
  const timestamp = '2026-09-30T12:00:00Z'
  const state: BackendState = {
    connectionStatus: 'connected',
    quotes: [],
    diagnostics: [],
    updatedAt: timestamp,
    activeAccountId: 'test-account',
    accounts: [],
    orders: [
      {
        id: '1',
        accountId: 'test-account',
        symbol,
        side: 'sell',
        type: 'trailing-stop',
        duration: 'day',
        quantity: 1,
        trailingStopPips: 20,
        status: 'working',
        submittedAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    positions: [
      {
        id: 'p1',
        accountId: 'test-account',
        symbol,
        quantity: 1,
        averagePrice: 6000,
        markPrice: 6001,
      },
    ],
    executions: [],
    messages: [],
  }
  const mapped = toTradingState(state, 'IBKR', 'paper')
  expect(mapped.orders[0]).toMatchObject({ pipSize: 0.5, trailingStopPips: 20 })
  expect(mapped.positions[0]).toMatchObject({ pipSize: 0.5 })
  const unknown = toTradingState(
    {
      ...state,
      orders: state.orders.map((order) => ({
        ...order,
        symbol: { ...symbol, pipDefinition: undefined },
      })),
      positions: state.positions.map((position) => ({
        ...position,
        symbol: { ...symbol, pipDefinition: undefined },
      })),
    },
    'IBKR',
    'paper',
  )
  expect(unknown.orders[0]?.pipSize).toBeUndefined()
  expect(unknown.positions[0]?.pipSize).toBeUndefined()
})
