import type {
  OptionContractChartBridge,
  SdkSymbolInfo,
  TradingBrokerAdapter,
} from '@tradescript/pro/sdk'
import { MOCK_PROVIDER } from './mock/identity.js'

/** Broker qualification supplies the exact identity; display text never identifies a contract. */
export function createOptionChartBridge(
  broker: TradingBrokerAdapter,
  provider: 'ibkr' | 'mock',
): OptionContractChartBridge {
  return {
    async toChartSelection(selected) {
      if (!broker.resolveOptionContract) throw new Error('The broker cannot qualify option charts.')
      const { contract } = await broker.resolveOptionContract({ contract: selected })
      const id = contract.brokerContractId
      if (
        id === undefined ||
        (provider === 'ibkr' && (!Number.isSafeInteger(Number(id)) || Number(id) <= 0))
      ) {
        throw new Error('The broker did not return an exact option contract identity.')
      }
      const identity = provider === 'ibkr' ? `IBKR:${id}` : `mock-option:${id}`
      const symbol: SdkSymbolInfo = {
        ticker: `${contract.underlyingSymbolInfo.ticker} ${contract.expiration} ${contract.strike} ${contract.right === 'call' ? 'C' : 'P'}`,
        canonicalSymbol: identity,
        brokerSymbol: provider === 'ibkr' ? identity : String(id),
        type: 'option',
        ...(contract.exchange !== undefined ? { exchange: contract.exchange } : {}),
        ...(contract.currency !== undefined ? { currency: contract.currency } : {}),
        ...(provider === 'mock' ? { provider: MOCK_PROVIDER } : {}),
        instrument: {
          kind: 'option',
          underlying: contract.underlying,
          ...{ underlyingSymbolInfo: contract.underlyingSymbolInfo },
          expiration: contract.expiration,
          strike: contract.strike,
          right: contract.right,
          multiplier: contract.multiplier,
          brokerContractId: id,
        },
      }
      return symbol
    },
  }
}
