import type { OptionChainContract, OptionChainResult } from '@ibkr-terminal/contracts'
import { type APIRequestContext, expect } from '@playwright/test'
import type { SymbolInfo, TradingOptionContract } from '@tradescript/pro/sdk'
import { browserHeaders, expectJsonOk } from './session.js'

/** Native API inspection only: this does not supply a selector to an installed SDK widget. */
export async function readExplicitOptionCatalog(
  request: APIRequestContext,
  query: URLSearchParams,
  options: { notBefore?: number } = {},
): Promise<{
  catalog: OptionChainResult
  chain: OptionChainResult
  candidate: OptionChainContract
  legacyAmbiguous: boolean
  selection: { tradingClass: string; expiration: string }
}> {
  if (query.has('tradingClass') || query.has('expiration') || query.has('includeTradingClasses'))
    throw new Error('Option catalog discovery must begin without an assumed class or expiry.')
  const path = '/api/v1/ibkr/options/chain'
  const read = async (selection: Record<string, string>) => {
    const parameters = new URLSearchParams(query)
    for (const [key, value] of Object.entries(selection)) parameters.set(key, value)
    return request.get(`${path}?${parameters}`, { headers: browserHeaders, timeout: 90_000 })
  }
  const catalog = await expectJsonOk<OptionChainResult>(
    await read({ includeTradingClasses: 'true' }),
  )
  const tradingClasses = catalog.tradingClasses ?? []
  expect(tradingClasses.length).toBeGreaterThan(0)
  expect(tradingClasses.every((item) => item.id && item.exchange && item.multiplier > 0)).toBe(true)
  const legacyAmbiguous = new Set(tradingClasses.map((item) => item.id)).size > 1
  const legacyResponse = await read({})
  if (legacyAmbiguous) expect(legacyResponse.status()).toBe(409)
  else await expectJsonOk<OptionChainResult>(legacyResponse)

  // Date-only expiry metadata cannot establish today's precise trading deadline.
  // Explicitly request a future native catalog, rather than repeatedly rejecting
  // today's loaded rows while overlooking the unloaded future expirations.
  for (const tradingClass of tradingClasses) {
    const selection = { tradingClass: tradingClass.id }
    const calendar = await expectJsonOk<OptionChainResult>(await read(selection))
    expect(calendar.tradingClass).toBe(tradingClass.id)
    const expiration = calendar.expirations
      .map((item) => item.expiration)
      .filter((value) => Date.parse(value) > Math.max(Date.now(), options.notBefore ?? 0))
      .sort()[0]
    if (!expiration) continue
    const chain = await expectJsonOk<OptionChainResult>(await read({ ...selection, expiration }))
    expect(chain.underlying).toBe(catalog.underlying)
    expect(chain.tradingClass).toBe(tradingClass.id)
    const contracts = chain.expirations.flatMap((item) => item.contracts)
    expect(contracts.length).toBeGreaterThan(0)
    expect(
      contracts.every((item) => {
        const id = Number(item.contract.brokerContractId)
        return (
          Number.isSafeInteger(id) &&
          id > 0 &&
          item.contract.expiration === expiration &&
          item.contract.tradingClass === tradingClass.id &&
          ['call', 'put'].includes(item.contract.right)
        )
      }),
    ).toBe(true)
    const candidate = contracts[0]
    if (candidate)
      return {
        catalog,
        chain,
        candidate,
        legacyAmbiguous,
        selection: { ...selection, expiration },
      }
  }
  throw new Error('TWS returned no exact future option contract in the returned trading classes.')
}

/** The stable SDK transports a native ID and tuple; TWS supplies the class on qualification. */
export function toNativeSdkOptionContract(
  entry: OptionChainContract,
  underlyingSymbolInfo: SymbolInfo,
): TradingOptionContract {
  const contract = entry.contract
  const brokerContractId = contract.brokerContractId
  if (
    brokerContractId === undefined ||
    !Number.isSafeInteger(Number(brokerContractId)) ||
    Number(brokerContractId) <= 0 ||
    !contract.tradingClass ||
    contract.priceStep === undefined ||
    !Number.isFinite(contract.priceStep) ||
    contract.priceStep <= 0 ||
    !Number.isFinite(contract.multiplier) ||
    contract.multiplier <= 0
  )
    throw new Error('Provider option catalog omitted exact native identity or price increment.')
  return {
    underlying: contract.underlying,
    underlyingSymbolInfo,
    expiration: contract.expiration,
    strike: contract.strike,
    right: contract.right,
    multiplier: contract.multiplier,
    brokerContractId,
    priceStep: contract.priceStep,
    ...(contract.exchange === undefined ? {} : { exchange: contract.exchange }),
    ...(contract.route === undefined ? {} : { route: contract.route }),
    ...(contract.currency === undefined ? {} : { currency: contract.currency }),
    ...(contract.symbol === undefined ? {} : { symbol: contract.symbol }),
  }
}
