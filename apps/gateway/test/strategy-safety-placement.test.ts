import { EventEmitter } from 'node:events'
import {
  type Contract,
  EventName,
  type IBApi,
  type Order as IbOrder,
  OrderAction,
} from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { OptionOrderLegDraft, OrderDraft } from '../src/ibkr/types.js'

const symbol = { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' }

function fixture() {
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
  const resolve = vi.spyOn(service['requests'], 'requestContractDetails')
  resolve.mockImplementation(async (contract) => [
    {
      contract: { ...contract, conId: contract.conId ?? (contract.strike === 100 ? 10 : 20) },
      priceMagnifier: 1,
      validExchanges: contract.exchange,
      marketRuleIds: '26',
    },
  ])
  vi.spyOn(service['requests'], 'requestMarketRule').mockResolvedValue([
    { lowEdge: 0, increment: 0.01 },
  ])
  return { ib, store, service, resolve }
}

function draft(
  side: 'buy' | 'sell',
  prices: 'missing' | 'partial' | 'contradictory',
): OrderDraft & { optionLegs: OptionOrderLegDraft[] } {
  const legs: [OptionOrderLegDraft, OptionOrderLegDraft] = [
    {
      contract: {
        underlying: 'AAPL',
        underlyingSymbolInfo: symbol,
        expiration: '2027-01-15',
        strike: 100,
        right: 'call',
        multiplier: 100,
        currency: 'USD',
      },
      side: 'sell',
      positionEffect: 'open',
      quantity: 2,
      ratio: 1,
    },
    {
      contract: {
        underlying: 'AAPL',
        underlyingSymbolInfo: symbol,
        expiration: '2027-01-15',
        strike: 105,
        right: 'call',
        multiplier: 100,
        currency: 'USD',
      },
      side: 'buy',
      positionEffect: 'open',
      quantity: 6,
      ratio: 3,
    },
  ]
  if (prices !== 'missing') legs[0].price = side === 'sell' ? 1 : 10
  if (prices === 'contradictory') legs[1].price = side === 'sell' ? 10 : 1
  return {
    accountId: 'DU123',
    symbol,
    side,
    type: 'limit',
    duration: 'day',
    quantity: 2,
    limitPrice: 1.5,
    optionLegs: legs,
  }
}

function effectiveSides(contract: Contract, sent: IbOrder): string[] {
  expect(contract.comboLegs).toHaveLength(2)
  return (contract.comboLegs ?? []).map((leg) =>
    sent.action === OrderAction.BUY
      ? (leg.action ?? '')
      : leg.action === OrderAction.BUY
        ? OrderAction.SELL
        : OrderAction.BUY,
  )
}

describe('validated strategy quantities and explicit parent side reach the broker adapter', () => {
  it('sends the stated minimum credit for an equal-ratio spread without leg quotes', async () => {
    const { ib, service } = fixture()
    const input = draft('sell', 'missing')
    input.optionLegs = input.optionLegs.map((leg) => ({ ...leg, quantity: 2, ratio: 1 }))
    const placed = await service.placeOrder(input)
    const [, contract, sent] = ib.placeOrder.mock.calls[0] as [number, Contract, IbOrder]
    expect(sent.totalQuantity).toBe(2)
    expect(sent.action).toBe(OrderAction.SELL)
    expect(sent.lmtPrice).toBe(1.5)
    expect(placed.order.side).toBe('sell')
    expect(effectiveSides(contract, sent)).toEqual(['SELL', 'BUY'])
  })

  it.each([
    { side: 'buy', prices: 'missing' },
    { side: 'sell', prices: 'missing' },
    { side: 'buy', prices: 'partial' },
    { side: 'sell', prices: 'partial' },
    { side: 'buy', prices: 'contradictory' },
    { side: 'sell', prices: 'contradictory' },
  ] as const)(
    'preserves $side at the caller limit with $prices premiums through edits',
    async ({ side, prices }) => {
      const { ib, store, service } = fixture()
      const input = draft(side, prices)
      const preview = await service.previewOrder(input)
      expect(preview).toMatchObject({ accepted: true, estimatedCost: 300 })
      expect(ib.placeOrder).not.toHaveBeenCalled()
      const placed = await service.placeOrder(input)
      expect(placed.order).toMatchObject({ side, quantity: 2, remainingQuantity: 2 })
      const [, contract, sent] = ib.placeOrder.mock.calls[0] as [number, Contract, IbOrder]
      expect(sent).toMatchObject({
        action: side === 'buy' ? 'BUY' : 'SELL',
        totalQuantity: 2,
        lmtPrice: 1.5,
      })
      expect(effectiveSides(contract, sent)).toEqual(['SELL', 'BUY'])
      expect(
        contract.comboLegs?.map((leg) => Number(sent.totalQuantity) * Number(leg.ratio)),
      ).toEqual([2, 6])

      store.upsertOrder({ ...placed.order, status: 'working' })
      const modified = await service.modifyOrder('100', { limitPrice: 1.75 })
      const [, updatedContract, updatedWire] = ib.placeOrder.mock.calls[1] as [
        number,
        Contract,
        IbOrder,
      ]
      expect(modified.order).toMatchObject({ side, quantity: 2, limitPrice: 1.75 })
      expect(updatedWire).toMatchObject({ action: sent.action, totalQuantity: 2, lmtPrice: 1.75 })
      expect(effectiveSides(updatedContract, updatedWire)).toEqual(['SELL', 'BUY'])
    },
  )

  it.each([
    { kind: 'top-level sizing', patch: { quantity: 1 } },
    {
      kind: 'unequal leg units',
      patch: {
        optionLegs: draft('sell', 'missing').optionLegs.map((leg, i) => ({
          ...leg,
          quantity: i ? 9 : 2,
        })),
      },
    },
    {
      kind: 'single-leg side',
      patch: {
        optionLegs: draft('sell', 'missing')
          .optionLegs.slice(1)
          .map((leg) => ({ ...leg, quantity: 2, ratio: 1 })),
      },
    },
  ])('rejects $kind during preview and place before contract resolution', async ({ patch }) => {
    const { ib, service, resolve } = fixture()
    const input = { ...draft('sell', 'missing'), ...patch }
    expect((await service.previewOrder(input)).accepted).toBe(false)
    await expect(service.placeOrder(input)).rejects.toThrow()
    expect(resolve).not.toHaveBeenCalled()
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
})
