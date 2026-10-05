import type { BrokerAccountCurrencyConversion } from '@ibkr-terminal/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter.js'
import type { BackendState } from './types.js'

const symbol = { ticker: 'AAPL', currency: 'USD', type: 'stock' as const, exchange: 'SMART' }
const now = Date.parse('2026-09-30T17:00:00Z')
const state: BackendState = {
  connectionStatus: 'connected',
  activeAccountId: 'DU-TEST',
  accounts: [{ id: 'DU-TEST', label: 'Synthetic', currency: 'EUR' }],
  orders: [],
  positions: [],
  executions: [],
  quotes: [],
  messages: [],
  diagnostics: [],
  updatedAt: new Date(now).toISOString(),
}
const conversion: BrokerAccountCurrencyConversion = {
  fromCurrency: 'USD',
  toCurrency: 'EUR',
  rate: 0.903,
  asOf: now - 300,
  source: 'ibkr-live-fx:IBKR:12001:inverse-bid',
}

function fixture(response: () => Response | Promise<Response> = () => Response.json(conversion)) {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost:3000')
    if (url.pathname.endsWith('/state')) return Response.json(state)
    if (url.pathname.endsWith('/sessions'))
      return Response.json({ symbol: { minTick: 0.01 }, metadata: {} })
    if (url.pathname.endsWith('/currency-conversion')) return response()
    throw new Error(`Unexpected synthetic route ${url.pathname}; method ${init?.method}`)
  })
  vi.stubGlobal('fetch', fetch)
  return {
    fetch,
    adapter: createIbkrHttpBrokerAdapter({
      executionEnvironment: 'paper',
      connectionGeneration: 'synthetic-generation',
    }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('production adapter account-currency conversion metadata', () => {
  it('returns the typed exact fresh broker conversion for the selected account and currency', async () => {
    const { adapter, fetch } = fixture()
    const info = await adapter.getTradingSymbolInfo?.({ symbol, accountId: 'DU-TEST' })
    expect(info?.accountCurrencyConversion).toEqual(conversion)
    const call = fetch.mock.calls.find(([input]) => String(input).includes('currency-conversion'))
    expect(String(call?.[0])).toContain('/accounts/DU-TEST/currency-conversion?fromCurrency=USD')
    expect(call?.[1]?.headers).toMatchObject({ 'x-tradescript-connection': 'synthetic-generation' })
  })

  it('coalesces concurrent rate lookups without retaining a stale conversion cache', async () => {
    let respond: ((response: Response) => void) | undefined
    let started: (() => void) | undefined
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const { adapter, fetch } = fixture(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
          started?.()
        }),
    )
    await adapter.getState()
    const first = adapter.getTradingSymbolInfo?.({ symbol, accountId: 'DU-TEST' })
    const second = adapter.getTradingSymbolInfo?.({ symbol, accountId: 'DU-TEST' })
    await requestStarted
    expect(respond).toBeTypeOf('function')
    respond?.(Response.json(conversion))
    expect((await first)?.accountCurrencyConversion).toEqual(conversion)
    expect((await second)?.accountCurrencyConversion).toEqual(conversion)
    expect(
      fetch.mock.calls.filter(([input]) => String(input).includes('currency-conversion')),
    ).toHaveLength(1)
  })

  it.each([
    { fromCurrency: 'JPY' },
    { toCurrency: 'USD' },
    { rate: -1 },
    { asOf: now - 60_000 },
    { asOf: now + 1 },
    { source: 'unqualified-midpoint' },
  ])('rejects inconsistent or stale conversion metadata %j', async (patch) => {
    const { adapter } = fixture(() => Response.json({ ...conversion, ...patch }))
    await expect(adapter.getTradingSymbolInfo?.({ symbol, accountId: 'DU-TEST' })).rejects.toThrow(
      /inconsistent or stale/,
    )
  })

  it.each(['connection', 'account-currency'] as const)(
    'rejects a late conversion after its %s authority changes',
    async (change) => {
      let respond: ((response: Response) => void) | undefined
      let started: (() => void) | undefined
      const requestStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const { adapter, fetch } = fixture(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve
            started?.()
          }),
      )
      const lookup = adapter.getTradingSymbolInfo?.({ symbol, accountId: 'DU-TEST' })
      const rejected = expect(lookup).rejects.toThrow(/connection or account currency changed/)
      await requestStarted
      if (change === 'connection') await adapter.disconnect?.()
      else {
        fetch.mockImplementation(async () =>
          Response.json({
            ...state,
            accounts: [{ ...state.accounts[0], currency: 'GBP' }],
          }),
        )
        await adapter.getState()
      }
      respond?.(Response.json(conversion))
      await rejected
    },
  )

  it('does not invent a conversion when the provider has no executable rate', async () => {
    const { adapter } = fixture(() => Response.json({ error: 'No live FX quote' }, { status: 503 }))
    const info = await adapter.getTradingSymbolInfo?.({ symbol, accountId: 'DU-TEST' })
    expect(info?.accountCurrencyConversion).toBeUndefined()
    expect(info?.supportedOrderTypes).toContain('market')
  })

  it('same-currency symbol metadata does not request an unnecessary conversion', async () => {
    const { adapter, fetch } = fixture()
    await adapter.getTradingSymbolInfo?.({
      symbol: { ...symbol, currency: 'EUR' },
      accountId: 'DU-TEST',
    })
    expect(fetch.mock.calls.some(([input]) => String(input).includes('currency-conversion'))).toBe(
      false,
    )
  })
})
