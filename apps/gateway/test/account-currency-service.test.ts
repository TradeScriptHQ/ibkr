import { EventEmitter } from 'node:events'
import { type Contract, type ContractDetails, EventName, type IBApi } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

function fixture(deferQualification = false) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T17:00:00Z'))
  const store = new BrokerStateStore()
  store.setAccounts([{ id: 'DU-TEST', label: 'Synthetic', currency: 'USD' }], 'DU-TEST')
  store.setConnectionStatus('connected')
  const ib = Object.assign(new EventEmitter(), {
    reqContractDetails: vi.fn((requestId: number, contract: Contract) => {
      if (!deferQualification) complete(requestId, contract)
    }),
    reqMktData: vi.fn((requestId: number, _contract: Contract) => {
      queueMicrotask(() => {
        ib.emit(EventName.marketDataType, requestId, 1)
        ib.emit(EventName.tickPrice, requestId, 1, 1.1)
        ib.emit(EventName.tickPrice, requestId, 2, 1.101)
      })
    }),
    cancelMktData: vi.fn(),
  })
  function complete(requestId: number, contract: Contract) {
    ib.emit(EventName.contractDetails, requestId, {
      contract: { ...contract, conId: 12001 },
    } as ContractDetails)
    ib.emit(EventName.contractDetailsEnd, requestId)
  }
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU-TEST' })),
    store,
    ib as unknown as IBApi,
  )
  return { service, store, ib, complete }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('account currency conversion through native service callbacks', () => {
  it('qualifies exact CASH identity and publishes only fresh live native bid/ask facts', async () => {
    const { service, ib } = fixture()
    const pending = service.getAccountCurrencyConversion('DU-TEST', 'EUR')
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: 1.101,
      source: 'ibkr-live-fx:IBKR:12001:ask',
    })
    expect(ib.reqMktData.mock.calls[0]?.[1]).toMatchObject({
      conId: 12001,
      secType: 'CASH',
      exchange: 'IDEALPRO',
      currency: 'USD',
    })
  })

  it('asks IBKR about a missing pair direction once instead of on every valuation', async () => {
    const { service, store, ib, complete } = fixture()
    store.setAccounts([{ id: 'DU-TEST', label: 'Synthetic', currency: 'EUR' }], 'DU-TEST')
    ib.reqContractDetails.mockImplementation((requestId: number, contract: Contract) => {
      if (contract.symbol === 'USD')
        ib.emit(EventName.error, new Error('No security definition has been found'), 200, requestId)
      else complete(requestId, contract)
    })
    for (let valuation = 0; valuation < 3; valuation += 1) {
      const pending = service.getAccountCurrencyConversion('DU-TEST', 'USD')
      await vi.advanceTimersByTimeAsync(100)
      expect(await pending).toMatchObject({ fromCurrency: 'USD', toCurrency: 'EUR' })
    }
    expect(ib.reqContractDetails.mock.calls.map(([, contract]) => contract.symbol)).toEqual([
      'USD',
      'EUR',
    ])
    service.beginOrderReconciliation()
    service.finishOrderReconciliation()
    const pending = service.getAccountCurrencyConversion('DU-TEST', 'USD')
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(ib.reqContractDetails).toHaveBeenCalledTimes(4)
  })

  it('refuses an unapproved account before any native request', async () => {
    const { service, ib } = fixture()
    await expect(service.getAccountCurrencyConversion('DU-OTHER', 'EUR')).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(ib.reqContractDetails).not.toHaveBeenCalled()
    expect(ib.reqMktData).not.toHaveBeenCalled()
  })

  it.each(['reconciliation', 'readiness', 'account-currency'] as const)(
    'rejects old qualification after %s changes even when currently connected',
    async (change) => {
      const { service, store, ib, complete } = fixture(true)
      const pending = service.getAccountCurrencyConversion('DU-TEST', 'EUR')
      const rejected = expect(pending).rejects.toMatchObject({ statusCode: 503 })
      if (change === 'reconciliation') {
        service.beginOrderReconciliation()
        service.finishOrderReconciliation()
      } else if (change === 'readiness') {
        service.setMarketDataReady(false)
        service.setMarketDataReady(true)
      } else store.setAccounts([{ id: 'DU-TEST', label: 'Synthetic', currency: 'JPY' }], 'DU-TEST')
      const request = ib.reqContractDetails.mock.calls[0]
      if (!request) throw new Error('Expected exact native qualification request')
      complete(request[0], request[1])
      await rejected
      expect(ib.reqMktData).not.toHaveBeenCalled()
    },
  )
})
