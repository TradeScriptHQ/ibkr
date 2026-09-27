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

function fixture() {
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const ib = new EventEmitter()
  const placeOrder = vi.fn()
  Object.assign(ib, {
    placeOrder,
    reqIds: vi.fn(),
    reqMktData: vi.fn(),
    cancelMktData: vi.fn(),
  })
  const service = new IbkrService(createBridgeConfig(loadGatewayConfig({})), store, ib as IBApi)
  return { service, ib, placeOrder }
}

describe('IBKR stock contract routing', () => {
  it('retains international listings and qualifies the selected currency and primary exchange', async () => {
    const { service } = fixture()
    const boundary = service as unknown as {
      requestMatchingSymbols: () => Promise<ContractDescription[]>
      requestContractDetails: (contract: Contract) => Promise<ContractDetails[]>
    }
    vi.spyOn(boundary, 'requestMatchingSymbols').mockResolvedValue([
      {
        contract: { conId: 1, symbol: 'SAP', secType: 'STK', currency: 'USD', primaryExch: 'NYSE' },
      },
      {
        contract: { conId: 2, symbol: 'SAP', secType: 'STK', currency: 'EUR', primaryExch: 'IBIS' },
      },
    ] as ContractDescription[])
    expect((await service.searchSymbols('SAP')).map((result) => result.symbol.currency)).toEqual([
      'USD',
      'EUR',
    ])
    const details = vi.spyOn(boundary, 'requestContractDetails').mockResolvedValue([
      {
        contract: {
          conId: 2,
          symbol: 'SAP',
          secType: 'STK',
          currency: 'EUR',
          exchange: 'SMART',
          primaryExch: 'IBIS',
        },
      },
    ] as ContractDetails[])
    expect(
      await service.resolveSymbol('SAP', {
        currency: 'EUR',
        exchange: 'SMART',
        primaryExchange: 'IBIS',
        assetClass: 'stock',
      }),
    ).toMatchObject({ ticker: 'SAP', currency: 'EUR', primaryExchange: 'IBIS' })
    expect(details).toHaveBeenCalledWith(
      expect.objectContaining({ secType: 'STK', currency: 'EUR', primaryExch: 'IBIS' }),
    )
    details.mockResolvedValue([
      { contract: { conId: 2, symbol: 'SAP', secType: 'STK', currency: 'EUR' } },
      { contract: { conId: 3, symbol: 'SAP', secType: 'STK', currency: 'EUR' } },
    ] as ContractDetails[])
    await expect(service.resolveSymbol('SAP', { currency: 'EUR' })).rejects.toThrow(/ambiguous/)
  })

  it('qualifies broader forex pairs with TWS instead of fabricating a resolved instrument', async () => {
    const { service } = fixture()
    const boundary = service as unknown as {
      requestContractDetails: (contract: Contract) => Promise<ContractDetails[]>
    }
    const details = vi.spyOn(boundary, 'requestContractDetails').mockResolvedValue([
      {
        contract: {
          conId: 3,
          symbol: 'USD',
          secType: 'CASH',
          currency: 'HKD',
          exchange: 'IDEALPRO',
        },
      },
    ] as ContractDetails[])
    expect(await service.resolveSymbol('USDHKD')).toMatchObject({
      ticker: 'USDHKD',
      currency: 'HKD',
      type: 'forex',
    })
    expect(details).toHaveBeenCalledWith({
      symbol: 'USD',
      secType: 'CASH',
      currency: 'HKD',
      exchange: 'IDEALPRO',
    })
    details.mockRejectedValue(new Error('No security definition'))
    await expect(service.resolveSymbol('USDHKD')).rejects.toThrow('No security definition')
  })

  it('keeps the NASDAQ listing exchange separate from the SMART trading route', async () => {
    const { service } = fixture()
    const boundary = service as unknown as {
      requestMatchingSymbols: () => Promise<ContractDescription[]>
    }
    vi.spyOn(boundary, 'requestMatchingSymbols').mockResolvedValue([
      {
        contract: {
          conId: 265598,
          symbol: 'AAPL',
          secType: 'STK',
          exchange: '',
          primaryExch: 'NASDAQ',
          currency: 'USD',
          description: 'APPLE INC',
        },
      } as ContractDescription,
    ])

    const [result] = await service.searchSymbols('AAPL')

    expect(result.symbol).toMatchObject({
      ticker: 'AAPL',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
    })
  })

  it('repairs a legacy NASDAQ-routed AAPL symbol before submitting it to TWS', async () => {
    const { service, ib, placeOrder } = fixture()
    vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({
      accepted: true,
      source: 'local',
      confirmId: 'routing-regression',
    })
    ib.emit(EventName.nextValidId, 1199)

    await service.placeOrder({
      symbol: {
        symbol: 'AAPL',
        exchange: 'NASDAQ',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
        assetClass: 'stock',
      },
      side: 'buy',
      type: 'market',
      duration: 'day',
      quantity: 1,
    })

    expect(placeOrder).toHaveBeenCalledOnce()
    expect(placeOrder.mock.calls[0][1] as Contract).toMatchObject({
      symbol: 'AAPL',
      secType: 'STK',
      exchange: 'SMART',
      primaryExch: 'NASDAQ',
      currency: 'USD',
    })
  })

  it('preserves an explicitly selected valid direct-routing venue', async () => {
    const { service, ib, placeOrder } = fixture()
    vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({
      accepted: true,
      source: 'local',
      confirmId: 'direct-routing-regression',
    })
    ib.emit(EventName.nextValidId, 1200)

    await service.placeOrder({
      symbol: {
        symbol: 'AAPL',
        exchange: 'ISLAND',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
        assetClass: 'stock',
      },
      side: 'buy',
      type: 'limit',
      duration: 'day',
      quantity: 1,
      limitPrice: 1,
    })

    expect(placeOrder.mock.calls[0][1] as Contract).toMatchObject({
      exchange: 'ISLAND',
      primaryExch: 'NASDAQ',
    })
  })

  it('maps IBKR overnight durations to the required order flag and route', async () => {
    const { service, ib, placeOrder } = fixture()
    vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({
      accepted: true,
      source: 'local',
      confirmId: 'overnight-regression',
    })
    ib.emit(EventName.nextValidId, 1201)

    await service.placeOrder({
      symbol: {
        symbol: 'AAPL',
        exchange: 'SMART',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
        assetClass: 'stock',
      },
      side: 'buy',
      type: 'limit',
      duration: 'overnight',
      quantity: 1,
      limitPrice: 1,
    })

    expect(placeOrder.mock.calls[0][1] as Contract).toMatchObject({ exchange: 'OVERNIGHT' })
    expect(placeOrder.mock.calls[0][2]).toMatchObject({ tif: 'DAY', includeOvernight: true })
  })

  it.each([
    ['opg', 'OPG'],
    ['ioc', 'IOC'],
    ['fok', 'FOK'],
  ] as const)('maps %s to the IBKR %s time-in-force', async (duration, tif) => {
    const { service, ib, placeOrder } = fixture()
    vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({
      accepted: true,
      source: 'local',
      confirmId: `${duration}-regression`,
    })
    ib.emit(EventName.nextValidId, 1202)

    await service.placeOrder({
      symbol: {
        symbol: 'AAPL',
        exchange: 'SMART',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
        assetClass: 'stock',
      },
      side: 'buy',
      type: 'limit',
      duration,
      quantity: 1,
      limitPrice: 1,
    })

    expect(placeOrder.mock.calls[0][1] as Contract).toMatchObject({ exchange: 'SMART' })
    expect(placeOrder.mock.calls[0][2]).toMatchObject({ tif })
  })

  it('keeps SMART routing while enabling OVERNIGHT + DAY', async () => {
    const { service, ib, placeOrder } = fixture()
    vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({
      accepted: true,
      source: 'local',
      confirmId: 'overnight-day-regression',
    })
    ib.emit(EventName.nextValidId, 1203)

    await service.placeOrder({
      symbol: {
        symbol: 'AAPL',
        exchange: 'SMART',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
        assetClass: 'stock',
      },
      side: 'buy',
      type: 'limit',
      duration: 'overnight-day',
      quantity: 1,
      limitPrice: 1,
    })

    expect(placeOrder.mock.calls[0][1] as Contract).toMatchObject({ exchange: 'SMART' })
    expect(placeOrder.mock.calls[0][2]).toMatchObject({ tif: 'DAY', includeOvernight: true })
  })

  it('advertises only recognized IBKR time-in-force values from contract details', async () => {
    const { service } = fixture()
    const boundary = service as unknown as {
      requestContractDetails: () => Promise<ContractDetails[]>
    }
    vi.spyOn(boundary, 'requestContractDetails').mockResolvedValue([
      {
        contract: {
          conId: 265598,
          symbol: 'AAPL',
          secType: 'STK',
          exchange: 'SMART',
          primaryExch: 'NASDAQ',
          currency: 'USD',
        },
        orderTypes: 'MKT,LMT,DAY,GTC,OPG,IOC,GTD,FOK,UNSUPPORTED',
        validExchanges: 'SMART,ISLAND,OVERNIGHT',
        timeZoneId: 'US/Eastern',
      } as ContractDetails,
    ])

    const session = await service.resolveSession({
      symbol: 'AAPL',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      currency: 'USD',
      assetClass: 'stock',
    })

    expect(session.metadata?.supportedDurations).toEqual([
      { type: 'day', value: 'day', label: 'DAY', default: true },
      { type: 'gtc', value: 'gtc', label: 'GTC' },
      {
        type: 'custom',
        value: 'opg',
        label: 'OPG',
        supportedOrderTypes: ['market', 'limit'],
      },
      { type: 'ioc', value: 'ioc', label: 'IOC' },
      {
        type: 'gtd',
        value: 'gtd',
        label: 'GTD',
        hasDatePicker: true,
        hasTimePicker: true,
      },
      { type: 'fok', value: 'fok', label: 'FOK' },
      { type: 'custom', value: 'overnight-day', label: 'OVERNIGHT + DAY' },
      { type: 'custom', value: 'overnight', label: 'OVERNIGHT' },
    ])
  })
})

it('propagates symbol search failures instead of reporting no matches', async () => {
  const { service } = fixture()
  vi.spyOn(service['requests'], 'requestMatchingSymbols').mockRejectedValue(
    new Error('TWS search unavailable'),
  )
  await expect(service.searchSymbols('AAPL')).rejects.toThrow('TWS search unavailable')
})
