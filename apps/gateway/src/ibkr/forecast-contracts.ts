import { OptionType, SecType } from '@stoqey/ib'
import { fromIbSymbol, toIbContract } from './contracts.js'
import type { IbkrRequests } from './ibkr-requests.js'
import { RequestError } from './request-error.js'
import type { BrokerSymbol } from './types.js'

/** ForecastEx nets YES and NO at the same strike; closing never sends a SELL. */
export async function opposingForecastContract(
  requests: Pick<IbkrRequests, 'requestContractDetails'>,
  symbol: BrokerSymbol,
): Promise<BrokerSymbol> {
  if (symbol.assetClass !== 'event-contract' || symbol.exchange !== 'FORECASTX') {
    throw new RequestError(400, 'Select a ForecastEx outcome contract.')
  }
  const selected = await requests.requestContractDetails(toIbContract(symbol))
  if (selected.length !== 1)
    throw new RequestError(409, 'ForecastEx outcome must resolve to one exact contract.')
  const contract = selected[0]!.contract
  if (
    contract.secType !== SecType.OPT ||
    contract.exchange !== 'FORECASTX' ||
    !contract.conId ||
    !contract.symbol ||
    !contract.currency ||
    !contract.lastTradeDateOrContractMonth ||
    contract.strike === undefined ||
    ![OptionType.Call, OptionType.Put].includes(contract.right!)
  ) {
    throw new RequestError(409, 'IBKR omitted the ForecastEx outcome identity.')
  }
  const right = contract.right === OptionType.Call ? OptionType.Put : OptionType.Call
  const candidates = await requests.requestContractDetails({
    symbol: contract.symbol,
    secType: SecType.OPT,
    exchange: 'FORECASTX',
    currency: contract.currency,
    lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth.split(' ')[0]!,
    strike: contract.strike,
    right,
    ...(contract.tradingClass ? { tradingClass: contract.tradingClass } : {}),
  })
  const matches = candidates.filter(
    ({ contract: other }) =>
      other.conId &&
      other.conId !== contract.conId &&
      other.secType === SecType.OPT &&
      other.exchange === 'FORECASTX' &&
      other.symbol === contract.symbol &&
      other.currency === contract.currency &&
      other.strike === contract.strike &&
      other.right === right &&
      other.lastTradeDateOrContractMonth?.split(' ')[0] ===
        contract.lastTradeDateOrContractMonth?.split(' ')[0],
  )
  if (matches.length !== 1)
    throw new RequestError(409, 'IBKR did not return one exact opposing ForecastEx outcome.')
  return fromIbSymbol(matches[0]!.contract)
}
