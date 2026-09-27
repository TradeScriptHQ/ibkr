import { EventEmitter } from 'node:events'
import { type Contract, EventName, type IBApi } from '@stoqey/ib'
import { expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

function fixture() {
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const emitter = new EventEmitter()
  const reqContractDetails = vi.fn((requestId: number, contract: Contract) => {
    queueMicrotask(() => {
      emitter.emit(EventName.contractDetails, requestId, {
        contract,
        longName: 'APPLE INC',
        industry: 'Technology',
        minTick: 0.01,
      })
      emitter.emit(EventName.contractDetailsEnd, requestId)
    })
  })
  const ib = Object.assign(emitter, { reqContractDetails })
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({})),
    store,
    ib as unknown as IBApi,
  )
  return { service, store, reqContractDetails }
}

it('obtains business details from the requested IBKR contract', async () => {
  const { service, reqContractDetails } = fixture()
  const result = await service.getInstrumentDetails({
    symbol: 'AAPL',
    primaryExchange: 'NASDAQ',
    exchange: 'SMART',
    currency: 'USD',
    assetClass: 'stock',
  })
  expect(reqContractDetails).toHaveBeenCalledWith(
    expect.any(Number),
    expect.objectContaining({
      symbol: 'AAPL',
      primaryExch: 'NASDAQ',
      exchange: 'SMART',
      currency: 'USD',
      secType: 'STK',
    }),
  )
  expect(result).toMatchObject({
    name: 'APPLE INC',
    industry: 'Technology',
    minTick: 0.01,
    source: 'IBKR contract details',
  })
  expect(result.category).toBeUndefined()
})

it('rejects unsupported assets and disconnected sessions without guessing a stock contract', async () => {
  const { service, store, reqContractDetails } = fixture()
  await expect(
    service.getInstrumentDetails({ symbol: 'AAPL', assetClass: 'option' }),
  ).rejects.toThrow('unavailable for this asset class')
  store.setConnectionStatus('disconnected')
  await expect(service.getInstrumentDetails({ symbol: 'AAPL' })).rejects.toThrow('not connected')
  expect(reqContractDetails).not.toHaveBeenCalled()
})
