import { EventEmitter } from 'node:events'
import {
  type Contract,
  type ContractDescription,
  type ContractDetails,
  EventName,
  type IBApi,
} from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

function fixture(options: { connected?: boolean } = {}) {
  const store = new BrokerStateStore()
  store.setConnectionStatus(options.connected === false ? 'disconnected' : 'connected')
  const ib = new EventEmitter()
  Object.assign(ib, {
    reqIds: vi.fn(),
    reqMktData: vi.fn(),
    cancelMktData: vi.fn(),
    cancelHistoricalData: vi.fn(),
  })
  const service = new IbkrService(createBridgeConfig(loadGatewayConfig({})), store, ib as IBApi)
  return { service, ib }
}

function matching(
  service: IbkrService,
  descriptions: ContractDescription[],
  isins: Record<number, string | Error | undefined> = {},
) {
  const boundary = service as unknown as {
    requestMatchingSymbols: () => Promise<ContractDescription[]>
    requestContractDetails: (contract: Contract) => Promise<ContractDetails[]>
  }
  vi.spyOn(boundary, 'requestMatchingSymbols').mockResolvedValue(descriptions)
  return vi
    .spyOn(boundary, 'requestContractDetails')
    .mockImplementation(async (contract: Contract) => {
      const isin = isins[contract.conId ?? 0]
      if (isin instanceof Error) throw isin
      return [
        {
          contract,
          ...(isin === undefined ? {} : { secIdList: [{ tag: 'ISIN', value: isin }] }),
        } as ContractDetails,
      ]
    })
}

const stock = (conId: number, symbol: string, primaryExch: string, currency: string) =>
  ({
    contract: {
      conId,
      symbol,
      secType: 'STK',
      primaryExch,
      currency,
      description: `${symbol} INC`,
      issuerId: '',
    },
  }) as ContractDescription

const APPLE_ISIN = 'US0378331005'

describe('IBKR symbol search markets', () => {
  it('groups listings that share an ISIN across venues and currencies under the first listing', async () => {
    const { service } = fixture()
    const details = matching(
      service,
      [
        stock(265598, 'AAPL', 'NASDAQ', 'USD'),
        stock(38708077, 'AAPL', 'MEXI', 'MXN'),
        stock(242506861, 'AAPLUSD', 'EBS', 'USD'),
      ],
      { 265598: APPLE_ISIN, 38708077: APPLE_ISIN, 242506861: APPLE_ISIN },
    )
    const results = await service.searchSymbols('AAPL')
    expect(results.map((result) => result.group)).toEqual([
      { key: `ISIN:${APPLE_ISIN}`, label: 'AAPL' },
      { key: `ISIN:${APPLE_ISIN}`, label: 'AAPL' },
      { key: `ISIN:${APPLE_ISIN}`, label: 'AAPL' },
    ])
    expect(details).toHaveBeenCalledWith({ conId: 38708077 }, expect.any(Number))
    expect(results.map((result) => result.symbol.isin)).toEqual([
      APPLE_ISIN,
      APPLE_ISIN,
      APPLE_ISIN,
    ])
  })

  it('keeps a depositary receipt with its own ISIN apart from the shares it represents', async () => {
    const { service } = fixture()
    matching(
      service,
      [stock(265598, 'AAPL', 'NASDAQ', 'USD'), stock(532640894, 'AAPL', 'TSE', 'CAD')],
      { 265598: APPLE_ISIN, 532640894: 'CA03785Y1007' },
    )
    const groups = (await service.searchSymbols('AAPL')).map((result) => result.group?.key)
    expect(groups).toEqual([`ISIN:${APPLE_ISIN}`, 'ISIN:CA03785Y1007'])
  })

  it('leaves a row ungrouped when IBKR has no ISIN for it or the lookup fails', async () => {
    const { service } = fixture()
    matching(service, [stock(1, 'XYZ', 'NYSE', 'USD'), stock(2, 'XYZ', 'IBIS', 'EUR')], {
      2: new Error('No security definition has been found for the request'),
    })
    const results = await service.searchSymbols('XYZ')
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.group === undefined)).toBe(true)
    expect(results.every((result) => result.symbol.isin === undefined)).toBe(true)
  })

  it("looks each listing's ISIN up once and reuses it for later searches", async () => {
    const { service } = fixture()
    const details = matching(service, [stock(265598, 'AAPL', 'NASDAQ', 'USD')], {
      265598: APPLE_ISIN,
    })
    await service.searchSymbols('AAPL')
    await service.searchSymbols('AAP')
    expect(details).toHaveBeenCalledTimes(1)
  })

  it('preserves every intraday turn from one day of five-minute closes', async () => {
    const { service, ib } = fixture()
    const closes = [11, 12.5, 11.75, 13, 12.25, 14, 13.5, 14.25]
    const reqHistoricalData = vi.fn(
      (id: number, _contract: Contract, _end: string, _duration: string, _barSize: string) =>
        queueMicrotask(() => {
          closes.forEach((close, index) => {
            ib.emit(
              EventName.historicalData,
              id,
              String(1791300000 + index * 300),
              close,
              close,
              close,
              close,
              100,
              0,
              0,
            )
          })
          ib.emit(EventName.historicalData, id, 'finished', 0, 0, 0, 0, 0, 0, 0)
        }),
    )
    Object.assign(ib, { reqHistoricalData })
    const symbol = {
      symbol: 'AAPL',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      currency: 'USD',
      assetClass: 'stock',
    }
    expect(await service.getSparklines([symbol])).toEqual([{ symbol, values: closes }])
    expect(reqHistoricalData).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({
        symbol: 'AAPL',
        secType: 'STK',
        primaryExch: 'NASDAQ',
        currency: 'USD',
      }),
      expect.any(String),
      '1 D',
      '5 mins',
      'TRADES',
      expect.any(Number),
      expect.any(Number),
      false,
    )
  })

  it('serves a repeated symbol from the cache instead of asking IBKR again', async () => {
    const { service, ib } = fixture()
    const reqHistoricalData = vi.fn((id: number) =>
      queueMicrotask(() => {
        ib.emit(EventName.historicalData, id, '1791300000', 1, 1, 1, 1, 1, 0, 0)
        ib.emit(EventName.historicalData, id, '1791301800', 2, 2, 2, 2, 1, 0, 0)
        ib.emit(EventName.historicalData, id, 'finished', 0, 0, 0, 0, 0, 0, 0)
      }),
    )
    Object.assign(ib, { reqHistoricalData })
    const symbol = { symbol: 'MSFT', exchange: 'SMART', currency: 'USD', assetClass: 'stock' }
    await service.getSparklines([symbol])
    await service.getSparklines([symbol])
    expect(reqHistoricalData).toHaveBeenCalledTimes(1)
  })

  it('leaves out a symbol whose history fails without failing the batch', async () => {
    const { service, ib } = fixture()
    const reqHistoricalData = vi.fn((id: number, contract: Contract) =>
      queueMicrotask(() => {
        if (contract.symbol === 'BAD') {
          ib.emit(EventName.error, new Error('No security definition'), 200, id)
          return
        }
        ib.emit(EventName.historicalData, id, '1791300000', 1, 1, 1, 3, 1, 0, 0)
        ib.emit(EventName.historicalData, id, '1791301800', 2, 2, 2, 4, 1, 0, 0)
        ib.emit(EventName.historicalData, id, 'finished', 0, 0, 0, 0, 0, 0, 0)
      }),
    )
    Object.assign(ib, { reqHistoricalData })
    const good = { symbol: 'IBM', exchange: 'SMART', currency: 'USD', assetClass: 'stock' }
    const bad = { symbol: 'BAD', exchange: 'SMART', currency: 'USD', assetClass: 'stock' }
    expect(await service.getSparklines([bad, good])).toEqual([{ symbol: good, values: [3, 4] }])
  })

  it('refuses while the IBKR bridge is disconnected', async () => {
    const { service } = fixture({ connected: false })
    await expect(service.getSparklines([{ symbol: 'AAPL', assetClass: 'stock' }])).rejects.toThrow(
      'IBKR bridge is not connected',
    )
  })
})
