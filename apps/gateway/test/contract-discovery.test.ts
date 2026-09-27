import { EventEmitter } from 'node:events'
import {
  type Contract,
  type ContractDetails,
  EventName,
  type IBApi,
  OptionType,
  SecType,
} from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import {
  fromIbSymbol,
  toIbContract,
  toMarketSymbol,
  uniqueMarketSymbols,
} from '../src/ibkr/contracts.js'
import { IbkrRequests } from '../src/ibkr/ibkr-requests.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

function fixture(details: ContractDetails[], bond = false) {
  const emitter = new EventEmitter()
  const reqContractDetails = vi.fn((id: number, _contract: Contract) =>
    queueMicrotask(() => {
      if (bond) emitter.emit(EventName.error, new Error('Currency price factor warning'), 2130, id)
      for (const item of details)
        emitter.emit(bond ? EventName.bondContractDetails : EventName.contractDetails, id, item)
      emitter.emit(EventName.contractDetailsEnd, id)
    }),
  )
  const ib = Object.assign(emitter, { reqContractDetails }) as IBApi
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  return {
    ib,
    reqContractDetails,
    service: new IbkrService(createBridgeConfig(loadGatewayConfig({})), store, ib),
  }
}

const future: ContractDetails = {
  contract: {
    conId: 123,
    secType: SecType.FUT,
    symbol: 'MES',
    localSymbol: 'MESU6',
    exchange: 'CME',
    currency: 'USD',
    lastTradeDateOrContractMonth: '20260918',
    multiplier: 5,
  },
  minTick: 0.25,
}

describe('exact IBKR contract discovery', () => {
  it.each([
    [SecType.BOND, 'bond'],
    [SecType.WAR, 'warrant'],
    [SecType.CMDTY, 'commodity'],
    [SecType.CFD, 'cfd'],
  ])(
    'carries %s through native search and exact resolution without stock defaults',
    async (secType, assetClass) => {
      const details = { ...future, contract: { ...future.contract, secType, currency: undefined } }
      const { service, reqContractDetails } = fixture([details], secType === SecType.BOND)
      const rows = await service.searchSymbols('IBKR:123', 10, { assetClass, exchange: 'SMART' })
      expect(reqContractDetails).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ conId: 123, secType }),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.symbol).toMatchObject({
        type: assetClass,
        canonicalSymbol: 'IBKR:123',
        brokerSymbol: 'IBKR:123',
        contractIdentity: { conId: 123, securityType: secType },
      })
      expect(rows[0]?.symbol.currency).toBeUndefined()
      expect(fromIbSymbol(details.contract).currency).toBeUndefined()
      expect(
        await service.resolveSymbol('IBKR:123', { assetClass, exchange: 'SMART' }),
      ).toMatchObject({ canonicalSymbol: 'IBKR:123', type: assetClass })
      expect(reqContractDetails).toHaveBeenLastCalledWith(expect.any(Number), {
        conId: 123,
        exchange: 'SMART',
      })
      await expect(
        service.resolveSymbol('IBKR:123', { assetClass: 'stock', exchange: 'SMART' }),
      ).rejects.toThrow('different instrument type')
    },
  )

  it('reads bond sizing without requiring omitted currency and preserves the broker short name', async () => {
    const details: ContractDetails = {
      contract: { conId: 456, symbol: '', secType: SecType.BOND, exchange: 'SMART', currency: '' },
      descAppend: 'T 6 1/2 11/15/26',
      minTick: 0.00001,
      minSize: 1,
      sizeIncrement: 1,
      orderTypes: 'LMT,MKT,DAY',
      timeZoneId: 'US/Eastern',
      tradingHours: '20260914:0800-20260914:1700',
      liquidHours: '20260914:0800-20260914:1700',
    }
    const { service, reqContractDetails } = fixture([details], true)
    const result = await service.resolveSession({
      symbol: 'IBKR:456',
      assetClass: 'bond',
      exchange: 'SMART',
    })
    expect(reqContractDetails).toHaveBeenLastCalledWith(expect.any(Number), {
      conId: 456,
      exchange: 'SMART',
    })
    expect(result.symbol).toMatchObject({
      currency: '',
      name: details.descAppend,
      description: details.descAppend,
    })
    expect(result.metadata).toMatchObject({
      minQuantity: 1,
      quantityStep: 1,
      orderTypes: 'LMT,MKT,DAY',
    })
    expect(() =>
      toIbContract({ symbol: 'IBKR:456', assetClass: 'bond', exchange: 'SMART' }),
    ).toThrow(/currency/)
    await expect(
      service.resolveSession({ symbol: 'IBKR:456', assetClass: 'futures', exchange: 'SMART' }),
    ).rejects.toThrow(/different instrument type/)
  })

  it('uses the exact contract ID as the bond display label when TWS omits its symbol', () => {
    expect(
      toMarketSymbol({
        contract: {
          secType: SecType.BOND,
          conId: 123,
          symbol: '',
          currency: '',
          exchange: 'SMART',
        },
        longName: '',
      }),
    ).toMatchObject({
      ticker: 'IBKR:123',
      brokerSymbol: 'IBKR:123',
      canonicalSymbol: 'IBKR:123',
      type: 'bond',
      currency: '',
    })
  })

  it('discovers separate future expiries and resolves the selected contract ID', async () => {
    const december = {
      ...future,
      contract: {
        ...future.contract,
        conId: 124,
        localSymbol: 'MESZ6',
        lastTradeDateOrContractMonth: '20261218',
      },
    }
    const { service, reqContractDetails } = fixture([future, december])
    const results = await service.searchSymbols('MES', 10, {
      assetClass: 'futures',
      exchange: 'CME',
    })
    expect(results.map((row) => row.symbol.brokerSymbol)).toEqual(['IBKR:123', 'IBKR:124'])
    expect(results[1]?.symbol.contractMultiplier).toBe(5)
    expect(reqContractDetails).toHaveBeenCalledWith(expect.any(Number), {
      symbol: 'MES',
      secType: 'FUT',
      exchange: 'CME',
    })
    expect(
      toIbContract({ symbol: 'IBKR:124', assetClass: 'futures', exchange: 'CME', currency: 'USD' }),
    ).toEqual({ conId: 124, secType: 'FUT', exchange: 'CME', currency: 'USD' })
    expect(uniqueMarketSymbols(results.map((row) => row.symbol))).toHaveLength(2)
    expect(fromIbSymbol(december.contract).contractIdentity?.expiry).toBe('20261218')
  })

  it('coalesces repeated discovery and keeps exact contracts in separate cache entries', async () => {
    const { service, reqContractDetails } = fixture([future])
    const query = { symbol: 'MES', securityType: 'FUT', exchange: 'CME' }
    const [first, second] = await Promise.all([
      service.discoverContracts(query),
      service.discoverContracts(query),
    ])
    expect(first).toEqual(second)
    expect(reqContractDetails).toHaveBeenCalledTimes(1)
    await service.discoverContracts({ ...query, conId: 123 })
    expect(reqContractDetails).toHaveBeenCalledTimes(2)
  })

  it('forwards an explicit expiry or broker contract ID instead of broadening the request', async () => {
    const { service, reqContractDetails } = fixture([future])
    await service.searchSymbols('MES 202612', 10, { assetClass: 'futures', exchange: 'CME' })
    expect(reqContractDetails).toHaveBeenLastCalledWith(expect.any(Number), {
      symbol: 'MES',
      secType: 'FUT',
      exchange: 'CME',
      lastTradeDateOrContractMonth: '202612',
    })
    await service.searchSymbols('IBKR:123', 10, { assetClass: 'futures', exchange: 'CME' })
    expect(reqContractDetails).toHaveBeenLastCalledWith(expect.any(Number), {
      secType: 'FUT',
      exchange: 'CME',
      conId: 123,
    })
  })

  it('rejects ambiguity instead of choosing the first session contract', async () => {
    const { service } = fixture([
      future,
      { ...future, contract: { ...future.contract, conId: 124 } },
    ])
    await expect(
      service.resolveSession({
        symbol: 'IBKR:123',
        assetClass: 'futures',
        exchange: 'CME',
        currency: 'USD',
      }),
    ).rejects.toThrow(/exact IBKR contract/)
  })

  it('collects the separate bond callback and removes both listeners on completion', async () => {
    const details: ContractDetails = {
      contract: {
        conId: 456,
        symbol: 'US-T',
        secType: SecType.BOND,
        exchange: 'SMART',
        currency: 'USD',
      },
      coupon: 4.5,
      maturity: '20301115',
      cusip: 'TEST',
    }
    const { ib } = fixture([details], true)
    const requests = new IbkrRequests(ib, () => true)
    expect(await requests.requestContractDetails(details.contract)).toEqual([details])
    expect(ib.listenerCount(EventName.bondContractDetails)).toBe(0)
    expect(ib.listenerCount(EventName.contractDetails)).toBe(0)
  })

  it('preserves index classification and rejects futures without exact identity', () => {
    expect(
      toMarketSymbol({
        contract: {
          conId: 416904,
          symbol: 'SPX',
          secType: SecType.IND,
          exchange: 'CBOE',
          currency: 'USD',
        },
      })?.type,
    ).toBe('index')
    expect(() =>
      toIbContract({ symbol: 'MES', assetClass: 'futures', exchange: 'CME', currency: 'USD' }),
    ).toThrow(/exact IBKR contract/)
  })
})

it('originates paired ForecastEx identities and payout from exact IBKR contracts', () => {
  const contract = {
    conId: 11,
    symbol: 'FF',
    secType: SecType.OPT,
    exchange: 'FORECASTX',
    currency: 'USD',
    lastTradeDateOrContractMonth: '20260916',
    strike: 3.375,
    right: OptionType.Call,
  }
  const yes = toMarketSymbol({ contract, longName: 'Fed funds target' })!
  const no = toMarketSymbol({
    contract: { ...contract, conId: 12, right: OptionType.Put },
    longName: 'Fed funds target',
  })!
  expect(yes.prediction).toMatchObject({
    outcomeId: 'IBKR:11',
    outcomeLabel: 'Yes',
    priceConvention: 'probability',
    payout: { amount: 1, currency: 'USD' },
  })
  expect(no.prediction).toMatchObject({
    outcomeId: 'IBKR:12',
    outcomeLabel: 'No',
    marketId: yes.prediction!.marketId,
    eventId: yes.prediction!.eventId,
  })
  expect(
    toMarketSymbol({ contract: { ...contract, right: undefined } })?.prediction,
  ).toBeUndefined()
})
