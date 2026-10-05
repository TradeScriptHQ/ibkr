import { EventEmitter } from 'node:events'
import { type Contract, EventName, type IBApi, SecType } from '@stoqey/ib'
import { afterEach, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { fromIbOptionContract } from '../src/ibkr/contracts.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function fixture(contract: Partial<Contract> = {}) {
  vi.useFakeTimers()
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const native: Contract = {
    conId: 123,
    symbol: 'ES',
    secType: SecType.FOP,
    exchange: 'CME',
    currency: 'USD',
    multiplier: 50,
    right: 'C',
    strike: 5000,
    lastTradeDateOrContractMonth: '20261016',
    ...contract,
  }
  const ib = Object.assign(new EventEmitter(), {
    reqMktData: vi.fn(),
    cancelMktData: vi.fn(),
    reqContractDetails: vi.fn((id: number) => {
      ib.emit(EventName.contractDetails, id, {
        contract: native,
        minTick: 0.25,
        timeZoneId: 'America/Chicago',
        orderTypes: 'MKT,LMT',
        minSize: 1,
        sizeIncrement: 1,
      })
      ib.emit(EventName.contractDetailsEnd, id)
    }),
  })
  const service = new IbkrService(createBridgeConfig(loadGatewayConfig({})), store, ib as IBApi)
  return { service, store, ib }
}

const requested = { symbol: 'IBKR:123', assetClass: 'option', exchange: 'CME', currency: 'USD' }

it('qualifies the SDK option family by exact conId and retains actual FOP session sizing and quote type', async () => {
  const { service, ib } = fixture()
  expect(await service.resolveSymbol(requested.symbol, requested)).toMatchObject({
    type: 'futures-option',
    contractIdentity: { conId: 123, securityType: 'FOP', multiplier: 50 },
  })
  expect(await service.resolveSession(requested)).toMatchObject({
    symbol: { type: 'futures-option' },
    metadata: { contractMultiplier: 50 },
  })
  const quote = service.getQuotes([requested])[0]
  expect(quote.symbol).toMatchObject({
    assetClass: 'futures-option',
    contractIdentity: { conId: 123, securityType: 'FOP', multiplier: 50 },
  })
  expect(ib.reqMktData.mock.calls[0][1]).toMatchObject({
    conId: 123,
    secType: 'FOP',
    exchange: 'CME',
    currency: 'USD',
  })
})

it('uses authoritative readback metadata for exact SDK option quotes without converting FOP into OPT', () => {
  const { service, ib } = fixture()
  ib.emit(
    EventName.openOrder,
    71,
    {
      conId: 123,
      symbol: 'ES',
      secType: SecType.FOP,
      exchange: 'CME',
      currency: 'USD',
      multiplier: 50,
    },
    {
      account: 'paper-options',
      action: 'SELL',
      totalQuantity: 2,
      orderType: 'LMT',
      lmtPrice: 2,
      tif: 'DAY',
    },
    { status: 'Submitted' },
  )
  expect(service.getQuotes([requested])[0].symbol.assetClass).toBe('futures-option')
  expect(ib.reqMktData.mock.calls[0][1]).toMatchObject({ conId: 123, secType: 'FOP' })
})

it('qualifies a first native SDK quote request before choosing its option security type', async () => {
  const { service, ib } = fixture()
  const quotes = await service.getQualifiedQuotes([requested])
  expect(ib.reqContractDetails.mock.calls[0]?.[1]).toMatchObject({ conId: 123 })
  expect(quotes[0].symbol.contractIdentity?.securityType).toBe('FOP')
  expect(ib.reqMktData.mock.calls[0][1]).toMatchObject({ conId: 123, secType: 'FOP' })
})

it.each([
  ['different conId', { conId: 456 }],
  ['different instrument', { secType: SecType.STK }],
] as const)('rejects an SDK option request resolved to a %s', async (_label, contract) => {
  const { service, ib } = fixture(contract)
  await expect(service.resolveSymbol(requested.symbol, requested)).rejects.toThrow(
    /different.*(identity|type|contract)/i,
  )
  await expect(service.resolveSession(requested)).rejects.toThrow(
    /different.*(identity|type|contract)/i,
  )
  expect(ib.reqMktData).not.toHaveBeenCalled()
})

it('does not fabricate a standard option multiplier when native readback omitted it', () => {
  expect(
    fromIbOptionContract({
      conId: 123,
      symbol: 'ES',
      secType: SecType.FOP,
      exchange: 'CME',
      currency: 'USD',
      right: 'C',
      strike: 5000,
      lastTradeDateOrContractMonth: '20261016',
    }),
  ).toBeUndefined()
})
