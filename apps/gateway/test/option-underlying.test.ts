import { EventEmitter } from 'node:events'
import {
  type Contract,
  type ContractDetails,
  EventName,
  type IBApi,
  OptionType,
  SecType,
} from '@stoqey/ib'
import { expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

it.each([SecType.STK, SecType.IND, SecType.FUT])(
  'resolves an option underlying by its broker conId for %s',
  async (secType) => {
    const option: ContractDetails = {
      contract: {
        conId: 928264058,
        symbol: 'QQQ',
        localSymbol: 'QQQ   261008C00758000',
        secType: secType === SecType.FUT ? SecType.FOP : SecType.OPT,
        exchange: 'SMART',
        currency: 'USD',
        lastTradeDateOrContractMonth: '20261008 16:15:00 US/Eastern',
        strike: 758,
        right: OptionType.Call,
        multiplier: 100,
      },
      underConId: 320227571,
      underSecType: secType,
    }
    const underlying: ContractDetails = {
      contract: {
        conId: 320227571,
        symbol: 'QQQ',
        secType,
        exchange: secType === SecType.FUT ? 'CME' : secType === SecType.IND ? 'CBOE' : 'SMART',
        primaryExch: 'NASDAQ',
        currency: 'USD',
      },
    }
    const emitter = new EventEmitter()
    const reqContractDetails = vi.fn((id: number, contract: Contract) =>
      queueMicrotask(() => {
        emitter.emit(
          EventName.contractDetails,
          id,
          contract.conId === option.contract.conId ? option : underlying,
        )
        emitter.emit(EventName.contractDetailsEnd, id)
      }),
    )
    const ib = Object.assign(emitter, { reqContractDetails }) as IBApi
    const store = new BrokerStateStore()
    store.setConnectionStatus('connected')
    const service = new IbkrService(createBridgeConfig(loadGatewayConfig({})), store, ib)
    const result = await service.resolveSymbol('IBKR:928264058', {
      assetClass: 'option',
      exchange: 'SMART',
    })
    expect(result).toMatchObject({
      brokerSymbol: 'IBKR:928264058',
      option: {
        kind: 'option',
        underlying: 'QQQ',
        expiration: '2026-10-08',
        strike: 758,
        right: 'call',
        brokerContractId: 928264058,
        underlyingSymbolInfo: {
          ticker: 'QQQ',
          canonicalSymbol: 'IBKR:320227571',
          type: secType === SecType.FUT ? 'futures' : secType === SecType.IND ? 'index' : 'stock',
          exchange: underlying.contract.exchange,
          currency: 'USD',
        },
      },
    })
    expect(reqContractDetails).toHaveBeenCalledWith(expect.any(Number), { conId: 320227571 })
  },
)
