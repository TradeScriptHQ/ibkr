import type {
  BrokerAccountCurrencyConversion,
  BrokerSymbol,
  MarketQuote,
} from '@ibkr-terminal/contracts'
import { type Contract, type ContractDetails, SecType } from '@stoqey/ib'
import { RequestError } from './request-error.js'

interface ConversionProvider {
  requestContractDetails(contract: Contract, timeoutMs: number): Promise<ContractDetails[]>
  getQuotes(symbols: BrokerSymbol[], options: { maxAgeMs: number }): MarketQuote[]
  assertCurrent(): void
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

/** Values positive exposure conservatively from an exact live provider FX bid/ask, not account-window marks. */
export async function resolveAccountCurrencyConversion(
  fromCurrencyValue: string,
  toCurrencyValue: string,
  provider: ConversionProvider,
  options: { timeoutMs?: number; maxAgeMs?: number } = {},
): Promise<BrokerAccountCurrencyConversion> {
  const fromCurrency = fromCurrencyValue.trim().toUpperCase()
  const toCurrency = toCurrencyValue.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(fromCurrency) || !/^[A-Z]{3}$/.test(toCurrency))
    throw new RequestError(400, 'Exact instrument and account currencies are required.')
  provider.assertCurrent()
  const now = provider.now ?? Date.now
  const wait = provider.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  if (fromCurrency === toCurrency)
    return { fromCurrency, toCurrency, rate: 1, asOf: now(), source: 'same-currency' }
  const deadline = now() + (options.timeoutMs ?? 10_000)
  const maxAgeMs = options.maxAgeMs ?? 15_000
  let qualified: Contract | undefined
  let inverse = false
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [fromCurrency, toCurrency],
    [toCurrency, fromCurrency],
  ]
  for (const [base, quote] of pairs) {
    provider.assertCurrent()
    if (now() >= deadline)
      throw new RequestError(
        503,
        'Broker FX qualification exceeded its bounded conversion deadline.',
      )
    let details: ContractDetails[]
    try {
      details = await provider.requestContractDetails(
        { symbol: base, currency: quote, secType: SecType.CASH, exchange: 'IDEALPRO' },
        Math.max(1, Math.min(4_000, deadline - now())),
      )
    } catch (error) {
      if (error instanceof RequestError && error.statusCode === 404 && !inverse) {
        inverse = true
        continue
      }
      throw error
    }
    provider.assertCurrent()
    if (!details.length && !inverse) {
      inverse = true
      continue
    }
    const unique = new Map(details.map((item) => [item.contract.conId, item.contract]))
    if (
      details.some(
        ({ contract }) =>
          contract.symbol !== base ||
          contract.currency !== quote ||
          contract.secType !== SecType.CASH ||
          contract.exchange !== 'IDEALPRO',
      )
    )
      throw new RequestError(
        409,
        'Broker FX qualification contains conflicting native currency facts.',
      )
    if (unique.size !== 1)
      throw new RequestError(unique.size ? 409 : 404, 'One exact native FX contract is required.')
    qualified = [...unique.values()][0]
    if (
      !qualified ||
      qualified.secType !== SecType.CASH ||
      qualified.symbol !== base ||
      qualified.currency !== quote ||
      qualified.exchange !== 'IDEALPRO' ||
      !Number.isSafeInteger(qualified.conId) ||
      !(Number(qualified.conId) > 0)
    )
      throw new RequestError(
        409,
        'Broker FX qualification contradicts the requested currency pair.',
      )
    break
  }
  if (!qualified)
    throw new RequestError(404, 'Broker account currency conversion has no exact FX contract.')
  const symbol: BrokerSymbol = {
    symbol: `${qualified.symbol}${qualified.currency}`,
    canonicalSymbol: `IBKR:${qualified.conId}`,
    exchange: 'IDEALPRO',
    currency: qualified.currency,
    assetClass: 'forex',
    contractIdentity: { securityType: 'CASH', conId: qualified.conId },
  }
  while (now() < deadline) {
    provider.assertCurrent()
    const [quote] = provider.getQuotes([symbol], { maxAgeMs })
    if (
      quote &&
      (quote.symbol.contractIdentity?.conId !== qualified.conId ||
        quote.symbol.contractIdentity?.securityType !== 'CASH' ||
        quote.symbol.currency !== qualified.currency ||
        quote.symbol.exchange !== 'IDEALPRO' ||
        quote.symbol.assetClass !== 'forex')
    )
      throw new RequestError(409, 'FX quote does not belong to the qualified native currency pair.')
    if (quote?.ibkrErrorCode)
      throw new RequestError(503, `Broker FX quote is unavailable (${quote.ibkrErrorCode}).`)
    const bidTime = Date.parse(quote?.bidUpdatedAt ?? '')
    const askTime = Date.parse(quote?.askUpdatedAt ?? '')
    const observedAt = Math.min(bidTime, askTime)
    const current = now()
    if (
      quote?.status === 'ok' &&
      quote.marketDataType === 'live' &&
      Number.isFinite(quote.bid) &&
      Number(quote.bid) > 0 &&
      Number.isFinite(quote.ask) &&
      Number(quote.ask) >= Number(quote.bid) &&
      Number.isFinite(observedAt) &&
      bidTime <= current &&
      askTime <= current &&
      current - observedAt <= maxAgeMs
    ) {
      provider.assertCurrent()
      const rate = inverse ? 1 / Number(quote.bid) : Number(quote.ask)
      if (!Number.isFinite(rate) || rate <= 0)
        throw new RequestError(503, 'Broker FX conversion rate cannot be represented safely.')
      return {
        fromCurrency,
        toCurrency,
        rate,
        asOf: observedAt,
        source: `ibkr-live-fx:IBKR:${qualified.conId}:${inverse ? 'inverse-bid' : 'ask'}`,
      }
    }
    await wait(Math.min(100, Math.max(1, deadline - now())))
  }
  throw new RequestError(503, 'A fresh live exact FX bid/ask is unavailable for risk conversion.')
}
