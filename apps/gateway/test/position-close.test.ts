import { EventEmitter } from 'node:events'
import { type Contract, type IBApi, OptionType, SecType } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { fromIbPosition } from '../src/ibkr/order-conversion.js'
import { OrderExecution } from '../src/ibkr/order-execution.js'
import { validateDraft } from '../src/ibkr/order-validation.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

function fixture(contract: Contract, quantity = 3) {
  const store = new BrokerStateStore()
  const position = fromIbPosition('DU-test', contract, quantity, 100)
  store.upsertPosition(position)
  const execution = new OrderExecution(
    new EventEmitter() as IBApi,
    createBridgeConfig(loadGatewayConfig({})),
    store,
    { requestContractDetails: vi.fn() },
  )
  return { execution, position, store }
}

describe('position close uses the instrument execution contract', () => {
  it.each([SecType.OPT, SecType.FOP])(
    'closes %s with a typed leg and the exact option ID',
    async (secType) => {
      const { execution, position, store } = fixture({
        symbol: 'MES',
        conId: 456,
        secType,
        exchange: 'CME',
        currency: 'USD',
        multiplier: 5,
        right: OptionType.Call,
        strike: 6000,
        lastTradeDateOrContractMonth: '20261218',
      })
      const place = vi
        .spyOn(execution, 'placeOrder')
        .mockResolvedValue({ preview: { accepted: true } })
      await execution.closePosition(position.id, {}, { quantity: 1 })
      const draft = place.mock.calls[0]![0]
      expect(validateDraft(draft).accepted).toBe(true)
      expect(draft).toMatchObject({
        side: 'sell',
        quantity: 1,
        optionLegs: [{ side: 'sell', quantity: 1, contract: { brokerContractId: 456 } }],
      })
      expect(store.getState().positions[0]?.quantity).toBe(3)
    },
  )
  it('uses IOC for a funded crypto market sell on its original venue', async () => {
    const { execution, position } = fixture(
      { symbol: 'BTC', secType: SecType.CRYPTO, exchange: 'PAXOS', currency: 'USD' },
      0.003,
    )
    const place = vi
      .spyOn(execution, 'placeOrder')
      .mockResolvedValue({ preview: { accepted: true } })
    await execution.closePosition(position.id, {}, { quantity: 0.001 })
    const draft = place.mock.calls[0]![0]
    expect(validateDraft(draft).accepted).toBe(true)
    expect(draft).toMatchObject({
      side: 'sell',
      type: 'market',
      duration: 'ioc',
      quantity: 0.001,
      symbol: { exchange: 'PAXOS', assetClass: 'crypto' },
    })
  })
  it('previews the same close draft and preserves rejection instead of inventing acceptance', async () => {
    const { execution, position } = fixture(
      { symbol: 'BTC', secType: SecType.CRYPTO, exchange: 'PAXOS', currency: 'USD' },
      0.003,
    )
    const preview = vi
      .spyOn(execution, 'previewOrder')
      .mockResolvedValue({ accepted: false, reason: 'Broker route unavailable' })
    const place = vi
      .spyOn(execution, 'placeOrder')
      .mockResolvedValue({ preview: { accepted: true } })
    expect(await execution.previewClosePosition(position.id, {}, { quantity: 0.001 })).toEqual({
      accepted: false,
      reason: 'Broker route unavailable',
    })
    await execution.closePosition(position.id, {}, { quantity: 0.001 })
    expect(preview.mock.calls[0]![0]).toEqual(place.mock.calls[0]![0])
  })
  it('rejects closing more than the selected position without placing an order', async () => {
    const { execution, position } = fixture({
      symbol: 'AAPL',
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
    })
    const place = vi.spyOn(execution, 'placeOrder')
    await expect(execution.closePosition(position.id, {}, { quantity: 4 })).rejects.toThrow(
      /no more than/,
    )
    expect(place).not.toHaveBeenCalled()
  })
  it('rejects a close routed to an account that does not own the position', async () => {
    const { execution, position } = fixture({
      symbol: 'AAPL',
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
    })
    const place = vi.spyOn(execution, 'placeOrder')
    await expect(
      execution.closePosition(position.id, { accountId: 'DU-other' }, { quantity: 1 }),
    ).rejects.toThrow(/account/)
    expect(place).not.toHaveBeenCalled()
  })
})
