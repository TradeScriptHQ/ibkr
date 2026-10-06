import type { Contract, ContractDetails } from '@stoqey/ib'
import { denormalizeOptionExpiry } from './contracts.js'
import { positiveContractId, positiveInteger, positiveNumber } from './numbers.js'
import { RequestError } from './request-error.js'
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

/**
 * ContractDetails can append the last-trade time and zone to the expiry
 * ("20261007 16:00:00 US/Eastern"). stoqey/ib 1.6.7 splits it on the literal string
 * "\\s+", so the suffix survives, and IBKR rejects it on the market-data wire (10372).
 */
export function withWireOptionExpiry<T extends Contract>(contract: T): T {
  const expiry = contract.lastTradeDateOrContractMonth?.trim().split(/\s+/)[0]
  return expiry ? { ...contract, lastTradeDateOrContractMonth: expiry } : contract
}

/** Neither a tuple nor a caller-supplied conId authorizes choosing an arbitrary class. */
export function selectExactOptionDetails(
  details: ContractDetails[],
  query: Contract,
): Omit<ContractDetails, 'contract'> & { contract: Contract & { conId: number } } {
  const requestedId = positiveContractId(query.conId)
  const unique = new Map<number, ContractDetails>()
  for (const item of details) {
    const id = positiveContractId(item.contract?.conId)
    if (id === undefined || (requestedId !== undefined && id !== requestedId)) continue
    unique.set(id, item)
  }
  if (unique.size === 0) throw new RequestError(404, 'IBKR option contract was not found.')
  if (unique.size !== 1)
    throw new RequestError(
      409,
      'Select one exact IBKR option contract; the option tuple is ambiguous.',
    )
  const entry = unique.entries().next().value
  if (!entry) throw new RequestError(404, 'IBKR option contract was not found.')
  const [conId, match] = entry
  assertOptionIdentity(query, match.contract)
  return { ...match, contract: { ...match.contract, conId } }
}

export function assertOptionIdentity(query: Contract, actual: Contract): void {
  const sameExpiry =
    denormalizeOptionExpiry(
      String(actual.lastTradeDateOrContractMonth ?? actual.lastTradeDate ?? ''),
    ) ===
    denormalizeOptionExpiry(String(query.lastTradeDateOrContractMonth ?? query.lastTradeDate ?? ''))
  const right = (value: unknown) =>
    String(value ?? '')
      .toUpperCase()
      .replace('CALL', 'C')
      .replace('PUT', 'P')
  if (
    actual.secType !== query.secType ||
    actual.symbol?.toUpperCase() !== query.symbol?.toUpperCase() ||
    !sameExpiry ||
    Number(actual.strike) !== Number(query.strike) ||
    right(actual.right) !== right(query.right) ||
    actual.currency !== query.currency ||
    !(Number(actual.multiplier) > 0) ||
    Number(actual.multiplier) !== Number(query.multiplier) ||
    (query.tradingClass !== undefined && query.tradingClass !== actual.tradingClass)
  )
    throw new RequestError(
      404,
      'The qualified IBKR contract does not match the requested option identity.',
    )
}

export function selectOptionParameters(
  parameters: IbSecDefOptionParameters[],
  requestedExchange: string,
  tradingClass?: string,
): IbSecDefOptionParameters | undefined {
  const usable = parameters.filter(
    (item) =>
      item.expirations.length > 0 &&
      item.strikes.length > 0 &&
      (tradingClass === undefined || item.tradingClass === tradingClass),
  )
  const preferredExchange =
    requestedExchange && usable.some((item) => item.exchange === requestedExchange)
      ? requestedExchange
      : usable.some((item) => item.exchange === 'SMART')
        ? 'SMART'
        : undefined
  const preferred = preferredExchange
    ? usable.filter((item) => item.exchange === preferredExchange)
    : usable
  const classes = new Set(
    preferred.map((item) => `${item.underlyingConId}|${item.tradingClass}|${item.multiplier}`),
  )
  if (classes.size > 1)
    throw new RequestError(
      409,
      'Option chain unavailable: multiple IBKR trading classes require an explicit class selector.',
    )
  const selected = preferred[0]
  return selected
    ? {
        ...selected,
        expirations: [...new Set(preferred.flatMap((item) => item.expirations))],
        strikes: [...new Set(preferred.flatMap((item) => item.strikes))],
      }
    : undefined
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
      tradingClass: contract?.tradingClass,
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
    contract.brokerContractId ?? '',
    contract.multiplier,
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
    tradingClass: contract.tradingClass ?? source.tradingClass,
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
