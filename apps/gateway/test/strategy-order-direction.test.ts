import { EventEmitter } from 'node:events'
import { type Contract, EventName, type IBApi, OrderAction } from '@stoqey/ib'
import { expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { OrderDraft } from '../src/ibkr/types.js'

it.each([
  { side: 'buy', count: 1 },
  { side: 'sell', count: 1 },
  { side: 'buy', count: 2 },
  { side: 'sell', count: 2 },
] as const)(
  'preserves $side option contract with $count legs through edits',
  async ({ side, count }) => {
    const ib = Object.assign(new EventEmitter(), {
      placeOrder: vi.fn(),
      reqIds: vi.fn(),
      reqOpenOrders: vi.fn(),
    })
    const store = new BrokerStateStore()
    store.setConnectionStatus('connected')
    const service = new IbkrService(
      createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU123' })),
      store,
      ib as unknown as IBApi,
    )
    ib.emit(EventName.nextValidId, 100)
    vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({ accepted: true })
    vi.spyOn(service['requests'], 'requestContractDetails').mockImplementation(async (contract) => [
      { contract: { ...contract, conId: contract.strike === 100 ? 10 : 20 } },
    ])
    const symbol = { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' }
    const draft: OrderDraft = {
      accountId: 'DU123',
      symbol,
      side,
      type: 'limit',
      duration: 'day',
      quantity: 1,
      limitPrice: 2,
      optionLegs: [
        {
          contract: {
            underlying: 'AAPL',
            underlyingSymbolInfo: symbol,
            expiration: '2026-10-16',
            strike: 100,
            right: 'call',
            multiplier: 100,
          },
          side,
          positionEffect: 'open',
          quantity: 1,
          ratio: 1,
          price: 5,
        },
        {
          contract: {
            underlying: 'AAPL',
            underlyingSymbolInfo: symbol,
            expiration: '2026-10-16',
            strike: 105,
            right: 'call',
            multiplier: 100,
          },
          side: side === 'buy' ? 'sell' : 'buy',
          positionEffect: 'open',
          quantity: 1,
          ratio: 1,
          price: 3,
        },
      ],
    }
    draft.optionLegs = draft.optionLegs!.slice(0, count)
    await service.placeOrder(draft)
    const [, contract, order] = ib.placeOrder.mock.calls[0] as [
      number,
      Contract,
      { action: string; lmtPrice: number },
    ]
    expect(order.action).toBe(side === 'buy' ? OrderAction.BUY : OrderAction.SELL)
    expect(order.lmtPrice).toBe(2)
    const effectiveSides =
      count === 1
        ? [order.action]
        : contract.comboLegs!.map((leg) =>
            order.action === OrderAction.BUY
              ? leg.action
              : leg.action === OrderAction.BUY
                ? OrderAction.SELL
                : OrderAction.BUY,
          )
    expect(effectiveSides).toEqual(
      draft.optionLegs!.map((leg) => (leg.side === 'buy' ? OrderAction.BUY : OrderAction.SELL)),
    )
    ib.emit(EventName.openOrder, 100, contract, order, { status: 'Submitted' })
    await service.modifyOrder('100', { limitPrice: 2.1 })
    const [, modifiedContract, modifiedOrder] = ib.placeOrder.mock.calls[1]
    expect(modifiedContract).toEqual(contract)
    expect(modifiedOrder.action).toBe(order.action)
    expect(modifiedOrder.lmtPrice).toBe(2.1)
    service['orders'].rejectOrderForRequestError(
      new Error('Order being modified does not match original order.'),
      105,
      100,
    )
    expect(store.getState().orders.find((order) => order.id === '100')).toMatchObject({
      limitPrice: 2,
      status: 'working',
    })
    expect(store.getState().ordersHistory?.some((order) => order.id === '100')).toBe(false)
    expect(ib.reqOpenOrders).toHaveBeenCalledOnce()
  },
)
