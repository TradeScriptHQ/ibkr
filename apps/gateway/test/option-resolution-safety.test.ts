import { EventEmitter } from 'node:events'
import { type Contract, type ContractDetails, EventName, type IBApi, SecType } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { toIbOptionContract, withBrokerSourceSymbol } from '../src/ibkr/contracts.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { OptionContract, OrderDraft } from '../src/ibkr/types.js'

const underlying = withBrokerSourceSymbol({
  symbol: 'AAPL',
  assetClass: 'stock',
  exchange: 'SMART',
  currency: 'USD',
})
const option: OptionContract = {
  underlying: 'AAPL',
  underlyingSymbolInfo: underlying,
  expiration: '2027-01-15',
  strike: 100,
  right: 'call',
  multiplier: 100,
  currency: 'USD',
  exchange: 'SMART',
}
function fixture(contracts: Contract[]) {
  const ib = Object.assign(new EventEmitter(), { placeOrder: vi.fn(), reqIds: vi.fn() })
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU123' })),
    store,
    ib as unknown as IBApi,
  )
  ib.emit(EventName.nextValidId, 100)
  vi.spyOn(service['requests'], 'requestContractDetails').mockResolvedValue(
    contracts.map(
      (contract) =>
        ({
          contract,
          priceMagnifier: 1,
          validExchanges: contract.exchange,
          marketRuleIds: '26',
        }) as ContractDetails,
    ),
  )
  vi.spyOn(service['requests'], 'requestMarketRule').mockResolvedValue([
    { lowEdge: 0, increment: 0.01 },
  ])
  return { service, ib }
}
function draft(contract: OptionContract): OrderDraft {
  return {
    symbol: underlying,
    accountId: 'DU123',
    side: 'buy',
    type: 'limit',
    duration: 'day',
    quantity: 1,
    limitPrice: 2,
    optionLegs: [{ contract, quantity: 1, side: 'buy', positionEffect: 'open' }],
  }
}
const native = { ...toIbOptionContract(option), conId: 101, tradingClass: 'AAPL' }
describe('exact native option qualification', () => {
  it.each(['2027-01-15', '20270115'])(
    'uses the compact expiry for price-rule requalification and placement from %s',
    async (expiration) => {
      const decorated = {
        ...native,
        lastTradeDateOrContractMonth: '20270115 16:00:00 US/Eastern',
      }
      const { service, ib } = fixture([decorated])
      const requestDetails = vi.mocked(service['requests'].requestContractDetails)
      requestDetails.mockImplementation(async (query) => {
        if (query.lastTradeDateOrContractMonth !== '20270115')
          throw new Error('IBKR 10372: Invalid last trade date or contract month format.')
        return [
          {
            contract: decorated,
            priceMagnifier: 1,
            validExchanges: 'SMART',
            marketRuleIds: '26',
          },
        ] satisfies ContractDetails[]
      })
      const proposed = draft({ ...option, expiration, brokerContractId: 101 })

      const preview = await service.previewOrder(proposed)
      expect(preview.reason).toBeUndefined()
      expect(preview.accepted).toBe(true)
      await service.placeOrder(proposed)

      expect(requestDetails.mock.calls.length).toBeGreaterThan(2)
      for (const [query] of requestDetails.mock.calls)
        expect(query.lastTradeDateOrContractMonth).toBe('20270115')
      expect(ib.placeOrder).toHaveBeenCalledOnce()
      expect(ib.placeOrder.mock.calls[0]?.[1]).toMatchObject({
        conId: 101,
        lastTradeDateOrContractMonth: '20270115',
        secType: SecType.OPT,
      })
      expect(decorated.lastTradeDateOrContractMonth).toBe('20270115 16:00:00 US/Eastern')
    },
  )
  it.each([
    {
      family: 'equity option',
      underlying: 'AAPL',
      assetClass: 'stock',
      exchange: 'SMART',
      secType: SecType.OPT,
      multiplier: 100,
    },
    {
      family: 'futures option',
      underlying: 'ES',
      assetClass: 'futures',
      exchange: 'CME',
      secType: SecType.FOP,
      multiplier: 50,
    },
  ])('keeps raw provider terms separate from the $family wire expiry', async (family) => {
    const source = withBrokerSourceSymbol({
      symbol: family.underlying,
      assetClass: family.assetClass,
      exchange: family.exchange,
      currency: 'USD',
    })
    const requested: OptionContract = {
      ...option,
      underlying: family.underlying,
      underlyingSymbolInfo: source,
      exchange: family.exchange,
      multiplier: family.multiplier,
      brokerContractId: 101,
    }
    const decorated = {
      ...toIbOptionContract(requested),
      conId: 101,
      tradingClass: family.underlying,
      lastTradeDateOrContractMonth: '20270115 16:00:00 US/Eastern',
    }
    const { service, ib } = fixture([decorated])
    const proposed = { ...draft(requested), symbol: source }
    await service.placeOrder(proposed)

    expect(ib.placeOrder.mock.calls[0]?.[1]).toMatchObject({
      conId: 101,
      secType: family.secType,
      lastTradeDateOrContractMonth: '20270115',
    })
    const submitted = ib.placeOrder.mock.calls[0]
    if (!submitted) throw new Error('Fixture requires one submitted option order')
    ib.emit(EventName.openOrder, submitted[0], decorated, submitted[2], { status: 'Submitted' })
    await service.modifyOrder(String(submitted[0]), { limitPrice: 2.1 })
    expect(ib.placeOrder.mock.calls[1]?.[1]).toMatchObject({
      conId: 101,
      secType: family.secType,
      lastTradeDateOrContractMonth: '20270115',
    })
    expect(ib.placeOrder.mock.calls[1]?.[2]).toMatchObject({ lmtPrice: 2.1 })
    const leg = proposed.optionLegs?.[0]
    if (!leg) throw new Error('Fixture requires one exact option leg')
    const resolved = await service['orders']['resolveOptionLeg'](leg)
    expect(resolved.contract.lastTradeDateOrContractMonth).toBe('20270115')
    expect(resolved.providerContract.lastTradeDateOrContractMonth).toBe(
      '20270115 16:00:00 US/Eastern',
    )
    expect(decorated.lastTradeDateOrContractMonth).toBe('20270115 16:00:00 US/Eastern')
  })
  it('rejects a decorated native expiry that disagrees with the exact requested date', async () => {
    const { service, ib } = fixture([
      { ...native, lastTradeDateOrContractMonth: '20270219 16:00:00 US/Eastern' },
    ])
    const exact = { ...option, brokerContractId: 101 }
    expect(await service.resolveOptionContract(exact)).toMatchObject({ tradable: false })
    await expect(service.placeOrder(draft(exact))).rejects.toThrow(/does not match|differs/i)
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
  it('does not choose the first of two native option classes', async () => {
    const { service, ib } = fixture([native, { ...native, conId: 102, tradingClass: 'AAPL1' }])
    await expect(service.resolveOptionContract(option)).rejects.toThrow(/one exact|ambiguous/i)
    await expect(service.placeOrder(draft(option))).rejects.toThrow(/one exact|ambiguous/i)
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
  it('selects the specified conId even when another class is returned first', async () => {
    const { service, ib } = fixture([{ ...native, conId: 102 }, native])
    const exact = { ...option, brokerContractId: 101 }
    expect(await service.resolveOptionContract(exact)).toMatchObject({
      tradable: true,
      contract: { brokerContractId: 101 },
    })
    await service.placeOrder(draft(exact))
    expect(ib.placeOrder.mock.calls[0]?.[1]).toMatchObject({ conId: 101 })
  })
  it('verifies a supplied conId with IBKR rather than accepting a stale identifier', async () => {
    const { service, ib } = fixture([native])
    const wrong = { ...option, brokerContractId: 999 }
    expect(await service.resolveOptionContract(wrong)).toMatchObject({ tradable: false })
    await expect(service.placeOrder(draft(wrong))).rejects.toThrow(/not found/i)
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
  it.each([
    ['strike', { strike: 105 }],
    ['right', { right: 'P' }],
    ['expiry', { lastTradeDateOrContractMonth: '20270219' }],
    ['multiplier', { multiplier: 10 }],
    ['currency', { currency: 'EUR' }],
    ['security type', { secType: SecType.STK }],
  ] as const)(
    'rejects an exact conId whose %s disagrees with the requested option',
    async (_label, change) => {
      const { service, ib } = fixture([{ ...native, ...change }])
      const exact = { ...option, brokerContractId: 101 }
      expect(await service.resolveOptionContract(exact)).toMatchObject({ tradable: false })
      await expect(service.placeOrder(draft(exact))).rejects.toThrow(/does not match|differs/i)
      expect(ib.placeOrder).not.toHaveBeenCalled()
    },
  )
})
