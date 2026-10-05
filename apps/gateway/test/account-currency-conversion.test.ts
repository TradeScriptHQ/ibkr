import type { BrokerSymbol, MarketQuote } from '@ibkr-terminal/contracts'
import { type Contract, type ContractDetails, SecType } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { resolveAccountCurrencyConversion } from '../src/ibkr/account-currency-conversion.js'
import { brokerSymbolKey, normalizeBrokerSymbol, toIbQuoteContract } from '../src/ibkr/contracts.js'
import { RequestError } from '../src/ibkr/request-error.js'

function fixture() {
  let now = Date.parse('2026-09-30T17:00:00Z')
  const quotePatch: Partial<MarketQuote> = {}
  const requestContractDetails = vi.fn(
    async (contract: Contract): Promise<ContractDetails[]> => [
      { contract: { ...contract, conId: 12001 } },
    ],
  )
  const getQuotes = vi.fn((symbols: BrokerSymbol[]): MarketQuote[] => [
    {
      symbol: symbols[0]!,
      bid: 1.1,
      ask: 1.101,
      bidUpdatedAt: new Date(now - 300).toISOString(),
      askUpdatedAt: new Date(now - 100).toISOString(),
      timestamp: new Date(now).toISOString(),
      marketDataType: 'live',
      status: 'ok',
      ...quotePatch,
    },
  ])
  const assertCurrent = vi.fn()
  const provider = {
    requestContractDetails,
    getQuotes,
    assertCurrent,
    now: () => now,
    wait: async (ms: number) => {
      now += ms
    },
  }
  return { provider, quotePatch, at: () => now }
}

describe('exact broker currency conversion for monetary risk', () => {
  it('uses the qualified forward ask and oldest bid/ask observation, not a mid or account mark', async () => {
    const { provider, at } = fixture()
    const result = await resolveAccountCurrencyConversion('EUR', 'USD', provider)
    expect(result).toEqual({
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: 1.101,
      asOf: at() - 300,
      source: 'ibkr-live-fx:IBKR:12001:ask',
    })
    expect(provider.requestContractDetails).toHaveBeenCalledWith(
      { symbol: 'EUR', currency: 'USD', secType: SecType.CASH, exchange: 'IDEALPRO' },
      4_000,
    )
    expect(provider.getQuotes.mock.calls[0]?.[0][0]).toMatchObject({
      canonicalSymbol: 'IBKR:12001',
      contractIdentity: { securityType: 'CASH', conId: 12001 },
    })
  })

  it('qualifies the actual inverse pair only after direct contract absence and uses inverse bid', async () => {
    const { provider } = fixture()
    provider.requestContractDetails.mockRejectedValueOnce(new RequestError(404, 'No direct pair'))
    const result = await resolveAccountCurrencyConversion('USD', 'EUR', provider)
    expect(result.rate).toBeCloseTo(1 / 1.1)
    expect(result.source).toBe('ibkr-live-fx:IBKR:12001:inverse-bid')
    expect(provider.requestContractDetails.mock.calls[1]?.[0]).toMatchObject({
      symbol: 'EUR',
      currency: 'USD',
    })
  })

  it('does not mask a disconnected direct provider request by probing another pair', async () => {
    const { provider } = fixture()
    provider.requestContractDetails.mockRejectedValueOnce(new RequestError(503, 'Disconnected'))
    await expect(resolveAccountCurrencyConversion('EUR', 'USD', provider)).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(provider.requestContractDetails).toHaveBeenCalledTimes(1)
    expect(provider.getQuotes).not.toHaveBeenCalled()
  })

  it.each(['', 'BASE', 'US1'])(
    'requires exact real currency codes rather than %s',
    async (value) => {
      const { provider } = fixture()
      await expect(resolveAccountCurrencyConversion(value, 'USD', provider)).rejects.toMatchObject({
        statusCode: 400,
      })
      expect(provider.requestContractDetails).not.toHaveBeenCalled()
    },
  )

  it('same-currency identity needs no native request but still checks current account state', async () => {
    const { provider } = fixture()
    expect(await resolveAccountCurrencyConversion(' usd ', 'USD', provider)).toMatchObject({
      rate: 1,
      source: 'same-currency',
    })
    expect(provider.assertCurrent).toHaveBeenCalled()
    expect(provider.requestContractDetails).not.toHaveBeenCalled()
  })

  it('rejects conflicting same-conId qualification rows before requesting a quote', async () => {
    const { provider } = fixture()
    provider.requestContractDetails.mockResolvedValueOnce([
      {
        contract: {
          conId: 12,
          secType: SecType.CASH,
          symbol: 'EUR',
          currency: 'JPY',
          exchange: 'IDEALPRO',
        },
      },
      {
        contract: {
          conId: 12,
          secType: SecType.CASH,
          symbol: 'EUR',
          currency: 'USD',
          exchange: 'IDEALPRO',
        },
      },
    ])
    await expect(resolveAccountCurrencyConversion('EUR', 'USD', provider)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(provider.getQuotes).not.toHaveBeenCalled()
  })

  it.each([
    { marketDataType: 'delayed' as const, status: 'delayed' as const },
    { marketDataType: 'frozen' as const },
    { marketDataType: undefined },
    { bidUpdatedAt: '2026-09-30T16:00:00Z' },
    { askUpdatedAt: '2026-09-30T17:01:00Z' },
    { bid: 1.2, ask: 1.1 },
    { bid: 0 },
    { ask: undefined },
  ])('refuses stale, nonlive or inconsistent quote facts %j', async (patch) => {
    const { provider, quotePatch } = fixture()
    Object.assign(quotePatch, patch)
    await expect(
      resolveAccountCurrencyConversion('EUR', 'USD', provider, { timeoutMs: 200 }),
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('rejects an exact-looking quote with the wrong native contract', async () => {
    const { provider, quotePatch } = fixture()
    quotePatch.symbol = {
      symbol: 'EURUSD',
      currency: 'USD',
      exchange: 'IDEALPRO',
      assetClass: 'forex',
      contractIdentity: { securityType: 'CASH', conId: 999 },
    }
    await expect(resolveAccountCurrencyConversion('EUR', 'USD', provider)).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('a broker market-data error is an explicit unavailable rate, not an inverse-rate retry', async () => {
    const { provider, quotePatch } = fixture()
    quotePatch.ibkrErrorCode = 10197
    await expect(resolveAccountCurrencyConversion('EUR', 'USD', provider)).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(provider.requestContractDetails).toHaveBeenCalledTimes(1)
  })

  it('rechecks connection/account authority after native qualification', async () => {
    const { provider } = fixture()
    provider.assertCurrent
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new RequestError(503, 'Account changed')
      })
    await expect(resolveAccountCurrencyConversion('EUR', 'USD', provider)).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(provider.getQuotes).not.toHaveBeenCalled()
  })

  it('keeps exact CASH identity through normalization, cache key and native quote serialization', () => {
    const symbol: BrokerSymbol = {
      symbol: 'EURUSD',
      canonicalSymbol: 'IBKR:12001',
      exchange: 'IDEALPRO',
      currency: 'USD',
      assetClass: 'forex',
      contractIdentity: { securityType: 'CASH', conId: 12001 },
    }
    expect(normalizeBrokerSymbol(symbol).contractIdentity).toEqual(symbol.contractIdentity)
    expect(brokerSymbolKey(symbol)).toBe('IBKR:12001:IDEALPRO:USD')
    expect(toIbQuoteContract(symbol)).toMatchObject({ conId: 12001, secType: SecType.CASH })
    expect(() => toIbQuoteContract({ ...symbol, canonicalSymbol: 'IBKR:999' })).toThrow(/exact FX/)
  })
})
