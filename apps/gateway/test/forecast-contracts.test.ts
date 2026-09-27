import { EventEmitter } from 'node:events'
import { type ContractDetails, type IBApi, OptionType, SecType } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { fromIbSymbol } from '../src/ibkr/contracts.js'
import { opposingForecastContract } from '../src/ibkr/forecast-contracts.js'
import { OrderExecution } from '../src/ibkr/order-execution.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

const yes: ContractDetails = {
  contract: {
    symbol: 'FF',
    conId: 111,
    secType: SecType.OPT,
    exchange: 'FORECASTX',
    currency: 'USD',
    strike: 3.375,
    right: OptionType.Call,
    lastTradeDateOrContractMonth: '20260916 13:00:00 US/Central',
    tradingClass: 'FF',
    multiplier: 1,
  },
}
const no: ContractDetails = { contract: { ...yes.contract, conId: 222, right: OptionType.Put } }

function requests(second: ContractDetails[] = [no]) {
  return {
    requestContractDetails: vi.fn().mockResolvedValueOnce([yes]).mockResolvedValueOnce(second),
  }
}
describe('ForecastEx opposite outcome close', () => {
  it('resolves the opposite right at the identical event, strike and expiry', async () => {
    const api = requests()
    expect(await opposingForecastContract(api, fromIbSymbol(yes.contract))).toMatchObject({
      assetClass: 'event-contract',
      contractIdentity: { conId: 222, right: 'P' },
    })
    expect(api.requestContractDetails).toHaveBeenLastCalledWith(
      expect.objectContaining({
        symbol: 'FF',
        exchange: 'FORECASTX',
        right: 'P',
        strike: 3.375,
        lastTradeDateOrContractMonth: '20260916',
      }),
    )
  })
  it('rejects a different strike or an ambiguous opposing outcome', async () => {
    for (const candidates of [
      [{ ...no, contract: { ...no.contract, strike: 4 } }],
      [no, { ...no, contract: { ...no.contract, conId: 333 } }],
    ]) {
      await expect(
        opposingForecastContract(requests(candidates), fromIbSymbol(yes.contract)),
      ).rejects.toThrow(/exact opposing/)
    }
  })
  it('retains the exact resolved venue when a position callback omits its exchange', () => {
    const execution = new OrderExecution(
      new EventEmitter() as IBApi,
      createBridgeConfig(loadGatewayConfig({})),
      new BrokerStateStore(),
      requests(),
    )
    execution.rememberSourceSymbol(yes.contract, fromIbSymbol(yes.contract))
    const { exchange: _exchange, ...positionContract } = yes.contract
    expect(execution.symbolFromContract(positionContract)).toMatchObject({
      exchange: 'FORECASTX',
      assetClass: 'event-contract',
      contractIdentity: { conId: 111 },
    })
  })

  it('closes only the requested quantity by buying the opposing contract at its fresh ask', async () => {
    const store = new BrokerStateStore()
    store.upsertPosition({
      id: 'owned-position',
      accountId: 'DU-test',
      symbol: fromIbSymbol(yes.contract),
      quantity: 3,
    })
    const execution = new OrderExecution(
      new EventEmitter() as IBApi,
      createBridgeConfig(loadGatewayConfig({})),
      store,
      requests(),
      (symbol) => ({ symbol, status: 'ok', ask: 0.04, timestamp: new Date().toISOString() }),
    )
    const place = vi
      .spyOn(execution, 'placeOrder')
      .mockResolvedValue({ preview: { accepted: true } })
    await execution.closePosition('owned-position', {}, { quantity: 1 })
    expect(place).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: expect.objectContaining({
          contractIdentity: expect.objectContaining({ conId: 222 }),
        }),
        side: 'buy',
        type: 'limit',
        limitPrice: 0.04,
        quantity: 1,
      }),
      {},
    )
    expect(store.getState().positions[0]?.quantity).toBe(3)
  })
})
