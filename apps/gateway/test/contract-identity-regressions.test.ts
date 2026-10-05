import { EventEmitter } from 'node:events'
import { type Contract, type ContractDescription, EventName, type IBApi, SecType } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import {
  brokerContractSourceRouteKey,
  fromIbSymbol,
  normalizeTicker,
  searchForexSymbols,
  toIbContract,
} from '../src/ibkr/contracts.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { fromIbOpenOrder } from '../src/ibkr/order-conversion.js'
import { OrderExecution } from '../src/ibkr/order-execution.js'
import { validateDraft } from '../src/ibkr/order-validation.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

function fixture() {
  vi.useFakeTimers()
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const ib = Object.assign(new EventEmitter(), { reqMktData: vi.fn(), cancelMktData: vi.fn() })
  const service = new IbkrService(createBridgeConfig(loadGatewayConfig({})), store, ib as IBApi)
  return { store, ib, service }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('contract identity regressions', () => {
  it('previews and modifies a restored unknown-effect option using the actual exact contract and sell quantity', async () => {
    vi.useFakeTimers()
    const store = new BrokerStateStore()
    store.setConnectionStatus('connected')
    store.setAccounts([{ id: 'paper-options', label: 'Paper options', currency: 'USD' }])
    const ib = Object.assign(new EventEmitter(), { placeOrder: vi.fn(), reqIds: vi.fn() })
    const service = new IbkrService(
      createBridgeConfig(
        loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'paper-options', IBKR_PORT: '7497' }),
      ),
      store,
      ib as IBApi,
    )
    const contract: Contract = {
      conId: 123,
      symbol: 'AAPL',
      secType: SecType.OPT,
      exchange: 'SMART',
      currency: 'USD',
      right: 'C',
      strike: 250,
      lastTradeDateOrContractMonth: '20261016',
      multiplier: 100,
    }
    const brokerOrder = {
      account: 'paper-options',
      action: 'SELL',
      totalQuantity: 5,
      orderType: 'LMT',
      lmtPrice: 2,
      tif: 'DAY',
    }
    vi.spyOn(service['requests'], 'requestContractDetails').mockImplementation(async (query) => [
      {
        contract: { ...contract, ...query },
        priceMagnifier: 1,
        validExchanges: query.exchange,
        marketRuleIds: '26',
      },
    ])
    vi.spyOn(service['requests'], 'requestMarketRule').mockResolvedValue([
      { lowEdge: 0, increment: 0.01 },
    ])
    ib.emit(EventName.nextValidId, 1001)
    ib.emit(EventName.openOrder, 71, contract, brokerOrder, { status: 'Submitted' })
    expect(store.getState().orders[0]).toMatchObject({
      side: 'sell',
      quantity: 5,
      symbol: { contractIdentity: { conId: 123 } },
    })
    expect(store.getState().orders[0].optionLegs).toBeUndefined()
    const modifying = service.modifyOrder(
      store.getState().orders[0].id,
      { quantity: 2, limitPrice: 2.25 },
      { accountId: 'paper-options' },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(ib.placeOrder).toHaveBeenCalledTimes(1)
    const [previewId, previewContract, previewOrder] = ib.placeOrder.mock.calls[0]
    expect(previewContract).toMatchObject({
      conId: 123,
      secType: SecType.OPT,
      exchange: 'SMART',
      currency: 'USD',
    })
    expect(previewOrder).toMatchObject({
      action: 'SELL',
      totalQuantity: 2,
      lmtPrice: 2.25,
      whatIf: true,
    })
    expect(previewOrder.openClose).toBeUndefined()
    ib.emit(EventName.openOrder, previewId, previewContract, previewOrder, {
      status: 'PreSubmitted',
      commission: 1,
    })
    expect((await modifying).preview).toMatchObject({
      estimatedCost: 450,
      estimatedCostSource: 'local',
    })
    expect(ib.placeOrder).toHaveBeenCalledTimes(2)
    expect(ib.placeOrder.mock.calls[1][0]).toBe(71)
    expect(ib.placeOrder.mock.calls[1][1]).toMatchObject({ conId: 123, secType: SecType.OPT })
    expect(ib.placeOrder.mock.calls[1][2]).toMatchObject({
      action: 'SELL',
      totalQuantity: 2,
      lmtPrice: 2.25,
    })
    expect(ib.placeOrder.mock.calls[1][2].openClose).toBeUndefined()
  })
  it.each([SecType.OPT, SecType.FOP])(
    'allows an exact no-leg %s readback without guessing an effect',
    (secType) => {
      const symbol = fromIbSymbol({
        symbol: 'ROOT',
        conId: 123,
        secType,
        exchange: 'SMART',
        currency: 'USD',
      })
      expect(toIbContract(symbol)).toMatchObject({
        conId: 123,
        secType,
        exchange: 'SMART',
        currency: 'USD',
      })
      expect(
        validateDraft({
          symbol,
          side: 'sell',
          type: 'limit',
          duration: 'day',
          quantity: 5,
          limitPrice: 2,
        }).accepted,
      ).toBe(true)
      expect(
        validateDraft({
          symbol,
          side: 'sell',
          type: 'limit',
          duration: 'day',
          quantity: 1.5,
          limitPrice: 2,
        }).accepted,
      ).toBe(false)
      expect(() => toIbContract({ ...symbol, canonicalSymbol: 'IBKR:444' })).toThrow(
        /identity|contract/i,
      )
      expect(() => toIbContract({ ...symbol, symbol: 'IBKR:444' })).toThrow(/identity|contract/i)
      expect(() =>
        toIbContract({
          symbol: 'ROOT',
          assetClass: symbol.assetClass,
          exchange: 'SMART',
          currency: 'USD',
        }),
      ).toThrow(/exact|contract/i)
    },
  )
  it.each([
    SecType.FUT,
    SecType.OPT,
    SecType.IND,
    SecType.BOND,
    SecType.FUND,
    SecType.WAR,
    SecType.CFD,
    SecType.CMDTY,
  ])('isolates remembered source identities for %s contracts', (secType) => {
    const execution = new OrderExecution(
      new EventEmitter() as IBApi,
      createBridgeConfig(loadGatewayConfig({})),
      new BrokerStateStore(),
      { requestContractDetails: vi.fn() },
    )
    const submitted: Contract = {
      conId: 1001,
      symbol: 'ROOT',
      secType,
      currency: 'USD',
      exchange: 'VENUE',
    }
    const readback: Contract = { ...submitted, conId: 2002 }
    const selected = {
      ...fromIbSymbol(submitted),
      sourceSymbol: {
        ticker: 'Selected contract',
        canonicalSymbol: 'IBKR:1001',
        brokerSymbol: 'IBKR:1001',
        currency: 'USD',
      },
    }
    execution.rememberSourceSymbol(submitted, selected)
    expect(brokerContractSourceRouteKey(readback)).not.toBe(brokerContractSourceRouteKey(submitted))
    expect(execution.symbolFromContract(readback).sourceSymbol?.canonicalSymbol).not.toBe(
      'IBKR:1001',
    )
    expect(execution.symbolFromContract(readback, selected).sourceSymbol?.canonicalSymbol).not.toBe(
      'IBKR:1001',
    )
    expect(execution.symbolFromContract(readback).sourceSymbol?.canonicalSymbol).not.toBe(
      'IBKR:1001',
    )
    const stalePreferred = { ...fromIbSymbol(readback), sourceSymbol: selected.sourceSymbol }
    expect(
      execution.symbolFromContract(readback, stalePreferred).sourceSymbol?.canonicalSymbol,
    ).not.toBe('IBKR:1001')
    expect(execution.symbolFromContract(readback).sourceSymbol?.canonicalSymbol).not.toBe(
      'IBKR:1001',
    )
  })

  it.each([SecType.STK, SecType.CASH, SecType.CRYPTO])(
    'retains conId-less natural route identity for %s',
    (secType) => {
      const submitted: Contract = { symbol: 'NATURAL', secType, currency: 'USD' }
      expect(brokerContractSourceRouteKey({ ...submitted, conId: 1001 })).toBe(
        brokerContractSourceRouteKey(submitted),
      )
      expect(brokerContractSourceRouteKey({ ...submitted, currency: 'EUR' })).not.toBe(
        brokerContractSourceRouteKey(submitted),
      )
    },
  )

  it('keeps ForecastEx strikes and outcomes in distinct quote streams and never falls back to another outcome', () => {
    const { store, service, ib } = fixture()
    const base: Contract = {
      symbol: 'FF',
      conId: 222,
      secType: SecType.OPT,
      exchange: 'FORECASTX',
      currency: 'USD',
      strike: 3.375,
      right: 'P',
    }
    const first = fromIbSymbol(base)
    const second = fromIbSymbol({ ...base, conId: 444, strike: 3.625 })
    service.getQuotes([first])
    const firstId = ib.reqMktData.mock.calls[0][0]
    ib.emit(EventName.tickPrice, firstId, 2, 0.11)
    expect(service.getQuotes([second])[0].ask).toBeUndefined()
    const secondId = ib.reqMktData.mock.calls[1][0]
    ib.emit(EventName.tickPrice, secondId, 2, 0.24)
    ib.emit(EventName.tickPrice, firstId, 2, 0.13)
    expect(store.getState().quotes).toHaveLength(2)
    expect(service.getQuotes([first])[0]).toMatchObject({
      ask: 0.13,
      symbol: { contractIdentity: { conId: 222 } },
    })
    expect(service.getQuotes([second])[0]).toMatchObject({
      ask: 0.24,
      symbol: { contractIdentity: { conId: 444 } },
    })
  })

  it('preserves whitespace-separated IBKR share classes', async () => {
    const { service } = fixture()
    const matches = vi.spyOn(service, 'requestMatchingSymbols').mockResolvedValue([
      {
        contract: {
          conId: 12,
          symbol: 'BRK B',
          secType: SecType.STK,
          currency: 'USD',
          exchange: 'SMART',
        },
      },
    ])
    expect(normalizeTicker('  brk\t  b  ')).toBe('BRK B')
    expect(normalizeTicker('  ibkr:123 ')).toBe('IBKR:123')
    expect(normalizeTicker('   ')).toBe('')
    expect((await service.searchSymbols('brk   b'))[0].symbol.ticker).toBe('BRK B')
    expect(matches).toHaveBeenCalledWith('BRK B', expect.any(Number))
  })

  it('keeps distinct listings of a natural stock in separate quote streams', () => {
    const { service, ib } = fixture()
    const nyse = {
      symbol: 'SAME',
      exchange: 'SMART',
      primaryExchange: 'NYSE',
      currency: 'USD',
      assetClass: 'stock',
    }
    const nasdaq = { ...nyse, primaryExchange: 'NASDAQ' }
    service.getQuotes([nyse])
    ib.emit(EventName.tickPrice, ib.reqMktData.mock.calls[0][0], 2, 10)
    expect(service.getQuotes([nasdaq])[0].ask).toBeUndefined()
    expect(ib.reqMktData).toHaveBeenCalledTimes(2)
    ib.emit(EventName.tickPrice, ib.reqMktData.mock.calls[1][0], 2, 20)
    expect(service.getQuotes([nyse])[0].ask).toBe(10)
    expect(service.getQuotes([nasdaq])[0].ask).toBe(20)
  })

  it.each(['LTC', 'BCH', 'NOK', 'HKD'])(
    'refuses to guess untyped %s quote subscriptions',
    (symbol) => {
      const { service, ib } = fixture()
      expect(() => service.getQuotes([{ symbol, currency: 'USD' }])).toThrow(
        /instrument type|asset class|exchange/i,
      )
      expect(ib.reqMktData).not.toHaveBeenCalled()
    },
  )

  it.each(['700', '7203', 'U'])(
    'keeps numeric and single-letter %s provider searches visible',
    async (query) => {
      const { service } = fixture()
      vi.spyOn(service, 'requestMatchingSymbols').mockResolvedValue([
        {
          contract: {
            conId: 77,
            symbol: query,
            secType: SecType.STK,
            currency: 'USD',
            exchange: 'SMART',
          },
        },
      ])
      expect(searchForexSymbols(query)).toEqual([])
      expect((await service.searchSymbols(query, 1))[0].symbol.ticker).toBe(query)
    },
  )

  it('keeps exact forex pairs first, other provider matches ahead of suggestions, and respects the asset filter', async () => {
    const { service } = fixture()
    const descriptions = [
      {
        contract: {
          conId: 77,
          symbol: 'EUR',
          secType: SecType.STK,
          currency: 'USD',
          exchange: 'SMART',
        },
      },
    ] as ContractDescription[]
    vi.spyOn(service, 'requestMatchingSymbols').mockResolvedValue(descriptions)
    expect((await service.searchSymbols('EUR', 1))[0].symbol).toMatchObject({
      ticker: 'EUR',
      type: 'stock',
    })
    expect(
      (await service.searchSymbols('EUR', 10, { assetClass: 'stock' })).every(
        (entry) => entry.symbol.type === 'stock',
      ),
    ).toBe(true)
    expect((await service.searchSymbols('EURUSD', 1))[0].symbol).toMatchObject({
      ticker: 'EURUSD',
      type: 'forex',
    })
  })

  it.each([
    ['O', 'open'],
    ['C', 'close'],
    [undefined, undefined],
  ] as const)('reads actual sell quantity and %s option position effect', (openClose, effect) => {
    const order = fromIbOpenOrder(
      70,
      {
        conId: 123,
        symbol: 'AAPL',
        secType: SecType.OPT,
        exchange: 'SMART',
        currency: 'USD',
        right: 'C',
        strike: 250,
        lastTradeDateOrContractMonth: '20261016',
        multiplier: 100,
      },
      { action: 'SELL', totalQuantity: 5, orderType: 'LMT', lmtPrice: 2, openClose },
      { status: 'Submitted' },
    )
    expect(order.symbol.contractIdentity?.conId).toBe(123)
    if (effect) {
      expect(order.optionLegs).toHaveLength(1)
      expect(order.optionLegs?.[0]).toMatchObject({
        side: 'sell',
        quantity: 5,
        ratio: 1,
        contract: { brokerContractId: 123 },
        positionEffect: effect,
      })
    } else {
      expect(order.optionLegs).toBeUndefined()
    }
  })
})
