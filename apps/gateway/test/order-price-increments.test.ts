import { EventEmitter } from 'node:events'
import { type Contract, type ContractDetails, EventName, type IBApi } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrRequests } from '../src/ibkr/ibkr-requests.js'
import { OrderExecution } from '../src/ibkr/order-execution.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { OrderDraft } from '../src/ibkr/types.js'

const draft: OrderDraft = {
  accountId: 'DU123',
  symbol: { symbol: 'TEST', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
  side: 'buy',
  type: 'stop',
  duration: 'day',
  quantity: 1,
  stopPrice: 1.05,
}
const bands = [
  { lowEdge: 0, increment: 0.01 },
  { lowEdge: 1, increment: 0.05 },
]
function fixture(increments = bands, validExchanges = 'SMART,ARCA', marketRuleIds = '26,27') {
  const ib = Object.assign(new EventEmitter(), { placeOrder: vi.fn(), reqIds: vi.fn() })
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const requests = {
    requestContractDetails: vi.fn(
      async (contract: Contract) =>
        [
          {
            contract: { ...contract, conId: 123 },
            validExchanges,
            marketRuleIds,
            priceMagnifier: 1,
          },
        ] satisfies ContractDetails[],
    ),
    requestMarketRule: vi.fn(async () => increments),
  }
  const execution = new OrderExecution(
    ib as unknown as IBApi,
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU123' })),
    store,
    requests,
  )
  ib.emit(EventName.nextValidId, 100)
  vi.spyOn(execution.previews, 'canUseIbkrWhatIfPreview').mockReturnValue(false)
  return { execution, requests, ib, store }
}

describe('native prices are validated at the proposed order price before dispatch', () => {
  it.each([1.03, 7250.89532])('rejects an off-grid stop %s without sending', async (stopPrice) => {
    const { execution, ib } = fixture()
    await expect(execution.placeOrder({ ...draft, stopPrice })).rejects.toThrow(/increment/iu)
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
  it('accepts a valid coarse-band stop and preserves exact wire price', async () => {
    const { execution, ib, requests } = fixture()
    await execution.placeOrder(draft)
    expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({ auxPrice: 1.05 })
    expect(requests.requestMarketRule).toHaveBeenCalledWith(26)
  })
  it('accepts a lower-price band independent of an unrelated quote', async () => {
    const { execution, ib } = fixture()
    await execution.placeOrder({ ...draft, stopPrice: 0.99 })
    expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({ auxPrice: 0.99 })
  })
  it('validates both stop-limit prices independently', async () => {
    const { execution, ib } = fixture()
    await expect(
      execution.placeOrder({ ...draft, type: 'stop-limit', stopPrice: 1.05, limitPrice: 1.06 }),
    ).rejects.toThrow(/increment/iu)
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
  it('uses the declared routing destination rule', async () => {
    const { execution, requests } = fixture([{ lowEdge: 0, increment: 0.25 }])
    await execution.placeOrder({ ...draft, routingDestination: 'ARCA', stopPrice: 1.25 })
    expect(requests.requestMarketRule).toHaveBeenCalledWith(27)
  })
  it.each([
    ['SMART,ARCA', '26'],
    ['ARCA', '26'],
    ['SMART', '0'],
  ])('refuses unavailable or misaligned route rules %s/%s', async (exchanges, ids) => {
    const { execution, ib } = fixture(bands, exchanges, ids)
    await expect(execution.placeOrder(draft)).rejects.toThrow(/price.*rule/iu)
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
  it.each([
    { increments: [{ lowEdge: 0, increment: 0 }] },
    {
      increments: [
        { lowEdge: 0, increment: 0.01 },
        { lowEdge: 0, increment: 0.05 },
      ],
    },
    {
      increments: [
        { lowEdge: 1, increment: 0.05 },
        { lowEdge: 0, increment: 0.01 },
      ],
    },
  ])('rejects malformed provider ladders without fallback', async ({ increments }) => {
    const { execution, ib } = fixture(increments)
    await expect(execution.placeOrder(draft)).rejects.toThrow(/price.*rule/iu)
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
  it('checks bracket child prices before any parent or preview wire dispatch', async () => {
    const { execution, ib } = fixture()
    await expect(
      execution.placeOrder({
        ...draft,
        type: 'limit',
        limitPrice: 1.05,
        exits: { levels: [{ id: 'one', quantity: 1, takeProfit: { price: 1.06 } }] },
      }),
    ).rejects.toThrow(/increment/iu)
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
  it('rejects an off-grid modification and retains the known working order', async () => {
    const { execution, store, ib } = fixture()
    store.upsertOrder({
      ...draft,
      id: '100',
      brokerOrderId: 100,
      clientId: 0,
      status: 'working',
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await expect(execution.modifyOrder('100', { stopPrice: 1.03 })).rejects.toThrow(/increment/iu)
    expect(ib.placeOrder).not.toHaveBeenCalled()
    expect(store.getState().orders[0]?.stopPrice).toBe(1.05)
  })
  it('does not demand a price rule for a plain market order with no price fields', async () => {
    const { execution, requests, ib } = fixture()
    await execution.placeOrder({ ...draft, type: 'market', stopPrice: undefined })
    expect(requests.requestMarketRule).not.toHaveBeenCalled()
    expect(ib.placeOrder).toHaveBeenCalledTimes(1)
  })
})

it.each(['market', 'limit'] as const)(
  'refuses %s monetary preview with a nontrivial native magnifier and no unit authority',
  async (type) => {
    const { execution, requests, ib } = fixture()
    requests.requestContractDetails.mockImplementation(async (contract) => [
      {
        contract: { ...contract, conId: 123 },
        priceMagnifier: 100,
        validExchanges: 'SMART',
        marketRuleIds: '26',
      },
    ])
    const result = await execution.previewOrder({
      ...draft,
      type,
      stopPrice: undefined,
      ...(type === 'limit' ? { limitPrice: 1.05 } : {}),
    })
    expect(result).toMatchObject({
      accepted: false,
      reason: expect.stringMatching(/monetary units.*unavailable/iu),
    })
    expect(ib.placeOrder).not.toHaveBeenCalled()
    expect(result.estimatedCost).toBeUndefined()
  },
)

it.each([undefined, 0, Number.NaN, -1])(
  'does not authorize monetary valuation with absent or invalid native magnifier %s',
  async (priceMagnifier) => {
    const { execution, requests, ib } = fixture()
    requests.requestContractDetails.mockImplementation(async (contract) => [
      {
        contract: { ...contract, conId: 123 },
        priceMagnifier,
        validExchanges: 'SMART',
        marketRuleIds: '26',
      },
    ])
    await expect(
      execution.placeOrder({ ...draft, type: 'market', stopPrice: undefined }),
    ).rejects.toThrow(/monetary units.*unavailable/iu)
    expect(ib.placeOrder).not.toHaveBeenCalled()
  },
)

it('does not infer a pounds/pence conversion from a GBP stock currency', async () => {
  const { execution, ib } = fixture([{ lowEdge: 0, increment: 0.5 }])
  await execution.placeOrder({
    ...draft,
    symbol: { ...draft.symbol, currency: 'GBP' },
    type: 'limit',
    stopPrice: undefined,
    limitPrice: 7250.5,
  })
  expect(ib.placeOrder.mock.calls[0]?.[1]).toMatchObject({ currency: 'GBP' })
  expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({ lmtPrice: 7250.5 })
})

it('uses a nonzero-first declared band only inside its provider range', async () => {
  const { execution, ib } = fixture([{ lowEdge: 1, increment: 0.25 }])
  await execution.placeOrder({ ...draft, stopPrice: 1.25 })
  expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({ auxPrice: 1.25 })
  const calls = ib.placeOrder.mock.calls.length
  await expect(execution.placeOrder({ ...draft, stopPrice: 0.75 })).rejects.toThrow(
    /rule.*unavailable/iu,
  )
  expect(ib.placeOrder).toHaveBeenCalledTimes(calls)
})

it('refuses an incomplete native ladder instead of dropping malformed rows and can recover on a new reply', async () => {
  const ib = Object.assign(new EventEmitter(), { reqMarketRule: vi.fn() })
  const requests = new IbkrRequests(ib as unknown as IBApi, () => true)
  const first = requests.requestMarketRule(26)
  const rejected = expect(first).rejects.toThrow(/increment/iu)
  ib.emit(EventName.marketRule, 27, [{ lowEdge: 0, increment: 0.01 }])
  ib.emit(EventName.marketRule, 26, [
    { lowEdge: 0, increment: 0.01 },
    { lowEdge: 1, increment: 0 },
  ])
  await rejected
  expect(ib.listenerCount(EventName.marketRule)).toBe(0)
  const recovered = requests.requestMarketRule(26)
  ib.emit(EventName.marketRule, 26, [
    { lowEdge: 0, increment: 0.01 },
    { lowEdge: 1, increment: 0.05 },
  ])
  expect(await recovered).toEqual(bands)
  expect(ib.reqMarketRule).toHaveBeenCalledTimes(2)
})

it.each([
  { price: 99999.999999, accepted: true },
  { price: 99999.9999994, accepted: false },
])(
  'validates exact high-price subcent units for $price without quotient drift',
  async ({ price, accepted }) => {
    const { execution, ib } = fixture([{ lowEdge: 0, increment: 0.000001 }])
    const order = { ...draft, stopPrice: price }
    if (accepted) {
      await execution.placeOrder(order)
      expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({ auxPrice: price })
    } else {
      await expect(execution.placeOrder(order)).rejects.toThrow(/increment/iu)
      expect(ib.placeOrder).not.toHaveBeenCalled()
    }
  },
)
