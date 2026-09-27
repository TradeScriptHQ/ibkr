import type { Contract } from '@stoqey/ib'
import { denormalizeOptionExpiry } from './contracts.js'
import { positiveContractId, positiveInteger, positiveNumber } from './numbers.js'
import type { BrokerSymbol, OptionChainContract, OptionContract } from './types.js'

export interface IbSecDefOptionParameters {
  exchange: string
  underlyingConId: number
  tradingClass: string
  multiplier: string
  expirations: string[]
  strikes: number[]
}

export type ResolvedOptionQuoteContract = Contract & {
  priceStep?: number | undefined
  priceIncrements?: Array<{ lowEdge: number; increment: number }> | undefined
}

export function selectOptionParameters(
  parameters: IbSecDefOptionParameters[],
  requestedExchange: string,
): IbSecDefOptionParameters | undefined {
  const usable = parameters.filter((item) => item.expirations.length > 0 && item.strikes.length > 0)
  if (requestedExchange) {
    const exact = usable.find((item) => item.exchange === requestedExchange)
    if (exact) return exact
  }
  const smart = usable.find((item) => item.exchange === 'SMART')
  if (smart) return smart
  return usable[0]
}

export function toOptionChainContract(
  contract: ResolvedOptionQuoteContract | undefined,
  context: {
    underlying: string
    underlyingSymbolInfo: BrokerSymbol
    expiration: string
    multiplier: number
    route: string
    currency: string
  },
): OptionChainContract | undefined {
  const brokerContractId = positiveContractId(contract?.conId)
  const strike = positiveNumber(Number(contract?.strike))
  const expiration = denormalizeOptionExpiry(
    String(contract?.lastTradeDateOrContractMonth ?? contract?.lastTradeDate ?? ''),
  )
  const brokerRight = String(contract?.right ?? '').toUpperCase()
  const right =
    brokerRight === 'C' || brokerRight === 'CALL'
      ? 'call'
      : brokerRight === 'P' || brokerRight === 'PUT'
        ? 'put'
        : undefined
  if (
    brokerContractId === undefined ||
    strike === undefined ||
    expiration !== context.expiration ||
    right === undefined
  ) {
    return undefined
  }
  return {
    contract: {
      underlying: String(contract?.symbol ?? context.underlying).toUpperCase(),
      underlyingSymbolInfo: context.underlyingSymbolInfo,
      expiration,
      strike,
      right,
      multiplier: Number(contract?.multiplier) || context.multiplier,
      exchange: contract?.exchange ?? context.route,
      route: context.route,
      currency: contract?.currency ?? context.currency,
      symbol: contract?.localSymbol ?? contract?.tradingClass,
      brokerContractId,
      priceStep: positiveNumber(contract?.priceStep),
      priceIncrements: contract?.priceIncrements,
    },
  }
}

export function uniqueOptionChainContracts(
  contracts: Array<OptionChainContract | undefined>,
): OptionChainContract[] {
  const unique = new Map<string, OptionChainContract>()
  for (const item of contracts) {
    if (!item) continue
    const key = `${item.contract.strike}|${item.contract.right}`
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()].sort((left, right) => {
    const strikeDifference = left.contract.strike - right.contract.strike
    if (strikeDifference !== 0) return strikeDifference
    return left.contract.right === right.contract.right
      ? 0
      : left.contract.right === 'call'
        ? -1
        : 1
  })
}

export function selectOptionQuoteWindowStrikes(
  strikes: number[],
  params: {
    centerPrice?: number | undefined
    quoteWindowRows?: number | undefined
    maxQuoteContracts?: number | undefined
  },
): number[] {
  const quoteWindowRows = positiveInteger(params.quoteWindowRows)
  const maxQuoteContracts = positiveInteger(params.maxQuoteContracts)
  const contractCappedRows =
    maxQuoteContracts == null ? undefined : Math.max(1, Math.floor(maxQuoteContracts / 2))
  const rowLimit = [quoteWindowRows, contractCappedRows]
    .filter((value): value is number => value != null)
    .reduce<number | undefined>(
      (limit, value) => (limit == null ? value : Math.min(limit, value)),
      undefined,
    )
  if (rowLimit == null || strikes.length <= rowLimit) return strikes
  const centerPrice = positiveNumber(params.centerPrice)
  const centerIndex =
    centerPrice == null
      ? Math.floor(strikes.length / 2)
      : strikes.reduce((closestIndex, strike, index) => {
          return Math.abs(strike - centerPrice) <
            Math.abs(Number(strikes[closestIndex]) - centerPrice)
            ? index
            : closestIndex
        }, 0)
  const half = Math.floor(rowLimit / 2)
  const start = Math.max(0, Math.min(strikes.length - rowLimit, centerIndex - half))
  return strikes.slice(start, start + rowLimit)
}

export function optionContractQuoteKey(contract: OptionContract): string {
  return [
    contract.underlying.toUpperCase(),
    denormalizeOptionExpiry(contract.expiration),
    contract.strike,
    contract.right,
    contract.currency ?? 'USD',
    contract.exchange ?? '',
    contract.route ?? '',
  ].join('|')
}

export function toResolvedOptionContract(
  source: OptionContract,
  contract: ResolvedOptionQuoteContract,
): OptionContract {
  const resolvedRight = String(contract.right ?? '').toUpperCase()
  return {
    ...source,
    underlying: String(contract.symbol ?? source.underlying).toUpperCase(),
    expiration: denormalizeOptionExpiry(
      String(contract.lastTradeDateOrContractMonth ?? contract.lastTradeDate ?? source.expiration),
    ),
    strike: Number(contract.strike ?? source.strike),
    right:
      resolvedRight === 'C' || resolvedRight === 'CALL'
        ? 'call'
        : resolvedRight === 'P' || resolvedRight === 'PUT'
          ? 'put'
          : source.right,
    multiplier: Number(contract.multiplier ?? source.multiplier) || source.multiplier,
    exchange: contract.exchange ?? source.exchange,
    route: source.route ?? contract.exchange,
    currency: contract.currency ?? source.currency,
    symbol: contract.localSymbol ?? source.symbol,
    brokerContractId: contract.conId ?? source.brokerContractId,
    priceStep: positiveNumber(contract.priceStep) ?? positiveNumber(source.priceStep),
    priceIncrements: contract.priceIncrements ?? source.priceIncrements,
  }
}

export function optionContractWithSourceIdentity(
  contract: OptionContract | undefined,
  symbol: BrokerSymbol,
): OptionContract | undefined {
  if (!contract || !symbol.sourceSymbol) return contract
  return {
    ...contract,
    underlyingSymbolInfo: {
      ...contract.underlyingSymbolInfo,
      sourceSymbol: symbol.sourceSymbol,
    },
  }
}
