import type { ContractPipDefinition, Order, OrderDraft } from '@ibkr-terminal/contracts'
import type { Contract, ContractDetails, Order as IbOrder, OrderState } from '@stoqey/ib'
import { afterEach, describe, expect, it } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { fromIbSymbol, toMarketSymbol } from '../src/ibkr/contracts.js'
import {
  fromIbOpenOrder,
  ibkrOrderModificationRejection,
  toIbOrder,
} from '../src/ibkr/order-conversion.js'
import { exitChildDrafts } from '../src/ibkr/order-exits.js'
import { applyOrderPatch, validateDraft } from '../src/ibkr/order-validation.js'
import {
  authoritativePipDefinition,
  ContractPipRegistry,
  installContractPipDefinitions,
  PROVIDER_PIP_DEFINITIONS,
} from '../src/ibkr/pip-definitions.js'

// These deliberately synthetic declared units prove transport/math, never provider data authority.
const facts: ContractPipDefinition[] = [
  {
    conId: 101,
    securityType: 'FUT',
    currency: 'USD',
    pipSize: 0.5,
    unit: 'quote-price-per-pip',
    source: 'approved-contract-catalog',
    reference: 'synthetic-fixture:futures-unit-not-minTick',
  },
  {
    conId: 202,
    securityType: 'CASH',
    currency: 'JPY',
    pipSize: 0.01,
    unit: 'quote-price-per-pip',
    source: 'approved-contract-catalog',
    reference: 'synthetic-fixture:JPY-unit-not-minTick',
  },
]
const native: Contract[] = [
  {
    conId: 101,
    secType: 'FUT',
    symbol: 'ES',
    localSymbol: 'ESZ6',
    exchange: 'CME',
    currency: 'USD',
  },
  { conId: 202, secType: 'CASH', symbol: 'USD', exchange: 'IDEALPRO', currency: 'JPY' },
]
const draft = (contract: Contract): OrderDraft => ({
  accountId: 'test-account',
  symbol: fromIbSymbol(contract),
  side: 'sell',
  type: 'trailing-stop',
  duration: 'day',
  quantity: 1,
  trailingStopPips: 20,
})
const order = (value: OrderDraft): Order => ({
  ...value,
  id: '100',
  status: 'working',
  submittedAt: '2026-09-30T10:00:00Z',
  updatedAt: '2026-09-30T10:00:00Z',
})
afterEach(() => installContractPipDefinitions([]))

describe.each(
  native.map((contract, index) => ({
    contract,
    fact:
      facts[index] ??
      (() => {
        throw new Error('Missing synthetic pip fact')
      })(),
  })),
)('declared $fact.securityType native pip unit', ({ contract, fact }) => {
  it('uses approved exact units for entry wire conversion and absolute broker readback', () => {
    installContractPipDefinitions(facts)
    const value = draft(contract)
    value.symbol.priceIncrements = [{ lowEdge: 0, increment: fact.pipSize / 2 }]
    expect(validateDraft(value).accepted).toBe(true)
    expect(toIbOrder(100, order(value), true)).toMatchObject({
      orderType: 'TRAIL',
      auxPrice: 20 * fact.pipSize,
    })
    expect(toIbOrder(100, order(value), true)).not.toHaveProperty('trailingPercent')
    const restored = fromIbOpenOrder(
      100,
      contract,
      {
        action: 'SELL',
        orderType: 'TRAIL',
        tif: 'DAY',
        totalQuantity: 1,
        auxPrice: 20 * fact.pipSize,
        trailingPercent: Number.MAX_VALUE,
      } as IbOrder,
      { status: 'Submitted' } as OrderState,
    )
    expect(restored.trailingStopPips).toBe(20)
    expect(restored.symbol.pipDefinition).toEqual(fact)
    expect(ibkrOrderModificationRejection(restored)).toBeUndefined()
    const amended = applyOrderPatch(restored, { trailingStopPips: 30 })
    expect(validateDraft(amended).accepted).toBe(true)
    expect(toIbOrder(100, order(amended), true).auxPrice).toBeCloseTo(30 * fact.pipSize)
    const percent = applyOrderPatch(restored, { trailPercent: 2 })
    expect(toIbOrder(100, order(percent), true)).toMatchObject({ trailingPercent: 2 })
    expect(toIbOrder(100, order(percent), true)).not.toHaveProperty('auxPrice')
  })

  it('retains exact units in provider session symbols and linked protection', () => {
    installContractPipDefinitions(facts)
    expect(
      toMarketSymbol({ contract, minTick: fact.pipSize / 2 } as ContractDetails),
    ).toMatchObject({
      contractIdentity: { conId: fact.conId, securityType: fact.securityType },
      pipDefinition: fact,
    })
    const parent = {
      ...draft(contract),
      type: 'market' as const,
      trailingStopPips: undefined,
      exits: {
        levels: [
          { id: 'trail', quantity: 1, stopLoss: { kind: 'trailing' as const, trailingPips: 20 } },
        ],
      },
    }
    expect(validateDraft(parent).accepted).toBe(true)
    const child = exitChildDrafts(parent)[0]
    if (!child) throw new Error('Missing exact trailing child')
    expect(toIbOrder(101, order(child.draft), true).auxPrice).toBe(20 * fact.pipSize)
  })
})

it('never accepts a client-supplied fact, ticker or tick increment as authority', () => {
  const value = draft(
    native[0] ??
      (() => {
        throw new Error('Missing native fixture')
      })(),
  )
  value.symbol.pipDefinition = facts[0]
  value.symbol.priceIncrements = [{ lowEdge: 0, increment: 0.5 }]
  expect(validateDraft(value).accepted).toBe(false)
  expect(() => toIbOrder(1, order(value), true)).toThrow('pip size')
  installContractPipDefinitions(facts)
  for (const symbol of [
    { ...value.symbol, currency: 'EUR' },
    { ...value.symbol, contractIdentity: { conId: 101, securityType: 'CASH' } },
    { ...value.symbol, canonicalSymbol: 'IBKR:999' },
    { ...value.symbol, symbol: 'ES', canonicalSymbol: undefined, contractIdentity: undefined },
  ])
    expect(authoritativePipDefinition(symbol)).toBeUndefined()
})

it('validates explicit approved server configuration and rejects duplicate or incomplete definitions', () => {
  const config = loadGatewayConfig({ IBKR_CONTRACT_PIP_DEFINITIONS: JSON.stringify(facts) })
  expect(createBridgeConfig(config).contractPipDefinitions).toEqual(facts)
  for (const value of [
    'not-json',
    JSON.stringify([{ ...facts[0], reference: '' }]),
    JSON.stringify([{ ...facts[0], unit: 'tick' }]),
    JSON.stringify([facts[0], facts[0]]),
  ])
    expect(() => loadGatewayConfig({ IBKR_CONTRACT_PIP_DEFINITIONS: value })).toThrow()
  const source = {
    ...(facts[0] ??
      (() => {
        throw new Error('Missing pip fixture')
      })()),
  }
  const registry = new ContractPipRegistry([source])
  source.pipSize = 999
  expect(
    registry.forSymbol(
      fromIbSymbol(
        native[0] ??
          (() => {
            throw new Error('Missing native fixture')
          })(),
      ),
    )?.pipSize,
  ).toBe(0.5)
})

it('binds the documented USDJPY pip only to its exact native CASH contract', () => {
  installContractPipDefinitions([])
  const contract: Contract = {
    conId: 15016059,
    secType: 'CASH',
    symbol: 'USD',
    currency: 'JPY',
    exchange: 'IDEALPRO',
  }
  const value = draft(contract)
  value.symbol.priceIncrements = [{ lowEdge: 0, increment: 0.001 }]
  expect(value.symbol.pipDefinition).toMatchObject({
    pipSize: 0.01,
    source: 'provider-specification',
    reference: 'https://www.interactivebrokers.com/campus/glossary-terms/pip/',
  })
  expect(validateDraft(value).accepted).toBe(true)
  expect(toIbOrder(1, order(value), true).auxPrice).toBe(0.2)
  expect(
    authoritativePipDefinition({
      ...value.symbol,
      canonicalSymbol: undefined,
      contractIdentity: undefined,
    }),
  ).toBeUndefined()
  expect(
    authoritativePipDefinition({
      ...value.symbol,
      canonicalSymbol: 'IBKR:15016060',
      contractIdentity: { conId: 15016060, securityType: 'CASH' },
    }),
  ).toBeUndefined()
  expect(authoritativePipDefinition({ ...value.symbol, currency: 'USD' })).toBeUndefined()
  expect(() =>
    loadGatewayConfig({ IBKR_CONTRACT_PIP_DEFINITIONS: JSON.stringify(PROVIDER_PIP_DEFINITIONS) }),
  ).toThrow('Duplicate')
  expect(() =>
    installContractPipDefinitions([
      {
        ...PROVIDER_PIP_DEFINITIONS[0],
        conId: 15016059,
        securityType: 'CASH',
        currency: 'JPY',
        pipSize: 999,
        unit: 'quote-price-per-pip',
        source: 'approved-contract-catalog',
        reference: 'synthetic-conflict',
      },
    ]),
  ).toThrow('Duplicate')
})
