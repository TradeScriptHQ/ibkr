import type { MarketSymbol, SymbolSearchResult } from '@ibkr-terminal/contracts'
import type { APIRequestContext, Page } from '@playwright/test'
import type { SymbolInfo } from '@tradescript/pro/sdk'
import { expect } from './fixtures.js'
import { browserHeaders, expectJsonOk } from './session.js'

export async function discover(
  request: APIRequestContext,
  root: string,
  assetClass: string,
  exchange: string,
): Promise<MarketSymbol[]> {
  const query = new URLSearchParams({ query: root, assetClass, exchange, limit: '50' })
  const rows = await expectJsonOk<SymbolSearchResult[]>(
    await request.get(`/api/v1/ibkr/symbols/search?${query}`, { headers: browserHeaders }),
  )
  expect(rows.length, `No ${root} ${assetClass} contracts returned by TWS`).toBeGreaterThan(0)
  return rows.map((row) => row.symbol)
}
export function descriptor(symbol: MarketSymbol): SymbolInfo {
  if (
    !symbol.brokerSymbol ||
    !symbol.canonicalSymbol ||
    !symbol.type ||
    !symbol.currency ||
    !symbol.exchange
  )
    throw new Error('Contract discovery omitted instrument identity')
  return {
    ticker: symbol.ticker,
    brokerSymbol: symbol.brokerSymbol,
    canonicalSymbol: symbol.canonicalSymbol,
    type: symbol.type,
    currency: symbol.currency,
    exchange: symbol.exchange,
    ...(symbol.minTick ? { tickSize: symbol.minTick } : {}),
  }
}
export function queryFor(symbol: SymbolInfo) {
  return new URLSearchParams({
    symbol: symbol.brokerSymbol ?? symbol.ticker,
    exchange: symbol.exchange ?? '',
    currency: symbol.currency ?? '',
    assetClass: symbol.type ?? '',
  })
}
export async function select(
  page: Page,
  root: string,
  assetLabel: string,
  symbol: MarketSymbol,
  options: { navigate?: boolean; chooseExchange?: boolean } = {},
) {
  if (options.navigate !== false) await page.goto('/')
  await page.getByRole('button', { name: /^Change symbol / }).click({ timeout: 60_000 })
  await page.getByRole('button', { name: assetLabel, exact: true }).click()
  if (!symbol.exchange) throw new Error('Missing contract venue')
  if (options.chooseExchange !== false)
    await page.getByRole('button', { name: symbol.exchange, exact: true }).click()
  await page.getByPlaceholder('Symbol', { exact: true }).fill(root)
  const rows = page
    .getByRole('listitem')
    .filter({ has: page.getByText(symbol.ticker, { exact: true }) })
    .filter({ hasText: symbol.primaryExchange ?? symbol.exchange })
  const listing =
    options.chooseExchange === false && symbol.currency
      ? rows.filter({ hasText: symbol.currency })
      : rows
  await listing.click()
  await expect(page.getByRole('button', { name: /^Change symbol / })).toContainText(
    symbol.name ?? symbol.ticker,
  )
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('ibkr-terminal:last-instrument:v1') ?? '{}')
            .canonicalSymbol,
      ),
    )
    .toBe(symbol.canonicalSymbol)
}

export async function resolveUsStock(request: APIRequestContext, ticker: 'AAPL' | 'MSFT') {
  const symbol = await expectJsonOk<MarketSymbol>(
    await request.get(
      `/api/v1/ibkr/symbols/resolve?${new URLSearchParams({
        symbol: ticker,
        assetClass: 'stock',
        exchange: 'SMART',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
      })}`,
      { headers: browserHeaders },
    ),
  )
  const conId = Number(/^IBKR:([1-9][0-9]*)$/u.exec(symbol.canonicalSymbol ?? '')?.[1])
  if (
    symbol.ticker !== ticker ||
    symbol.type !== 'stock' ||
    symbol.exchange !== 'SMART' ||
    symbol.currency !== 'USD' ||
    symbol.primaryExchange !== 'NASDAQ' ||
    !Number.isSafeInteger(conId) ||
    conId <= 0 ||
    (symbol.contractIdentity?.conId !== undefined && symbol.contractIdentity.conId !== conId) ||
    (symbol.contractIdentity?.securityType !== undefined &&
      symbol.contractIdentity.securityType !== 'STK')
  )
    throw new Error('TWS omitted the exact requested US stock identity')
  return symbol
}
