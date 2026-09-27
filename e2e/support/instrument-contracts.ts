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
export async function select(page: Page, root: string, assetLabel: string, symbol: MarketSymbol) {
  await page.goto('/')
  await page.getByRole('button', { name: /^Change symbol / }).click({ timeout: 60_000 })
  await page.getByRole('button', { name: assetLabel, exact: true }).click()
  if (!symbol.exchange) throw new Error('Missing contract venue')
  await page.getByRole('button', { name: symbol.exchange, exact: true }).click()
  await page.getByPlaceholder('Symbol', { exact: true }).fill(root)
  await page
    .getByRole('listitem')
    .filter({ has: page.getByText(symbol.ticker, { exact: true }) })
    .filter({ hasText: symbol.exchange })
    .click()
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
