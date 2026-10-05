import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { resolveUsStock, select } from './support/instrument-contracts.js'
import { openTerminalSession } from './support/session.js'

const sourceSdkPages = new WeakSet<Page>()
test.beforeEach(({ page }) => {
  page.on('response', (response) => {
    if (
      response.status() === 200 &&
      new URL(response.url()).pathname.endsWith('/src/sdk/sourceDevelopmentSdk.ts')
    )
      sourceSdkPages.add(page)
  })
})
test.afterEach(async ({ page }) => {
  const sourceSdkLoaded = sourceSdkPages.has(page)
  await test.info().attach('sdk-runtime-mode', {
    body: JSON.stringify({ sourceSdkLoaded }),
    contentType: 'application/json',
  })
  if (process.env.TERMINAL_E2E_SOURCE_MODE === '1')
    expect(sourceSdkLoaded, 'Source qualification must load the SDK source facade').toBe(true)
})

async function selectUsListing(page: Page, ticker: 'AAPL' | 'MSFT') {
  const markets = page.getByRole('region', { name: 'Markets', exact: true })
  const input = markets.getByRole('textbox')
  if (!(await input.isVisible()))
    await markets.getByRole('button', { name: 'Add symbol', exact: true }).click()
  await input.fill('')
  await input.fill(ticker)
  const listing = page
    .getByRole('listitem')
    .filter({ has: page.getByText(ticker, { exact: true }) })
    .filter({ hasText: 'SMART . NASDAQ . Stock . USD' })
  await expect(listing).toHaveCount(1)
  await listing.click()
}

async function addUsListing(page: Page, ticker: 'AAPL' | 'MSFT') {
  await selectUsListing(page, ticker)
  const markets = page.getByRole('region', { name: 'Markets', exact: true })
  await expect(markets.locator('[data-watchlist-row]')).toHaveCount(1)
  await expect(markets.locator('[data-watchlist-row]')).toContainText(ticker)
}

test('watchlist search preserves the selected listing when the chart shows another symbol', async ({
  page,
  context,
  request,
}) => {
  await context.addInitScript(() => {
    if (localStorage.getItem('watchlist-e2e-initialized') !== null) return
    localStorage.setItem('ibkr-terminal.watchlist.v2', '[]')
    localStorage.setItem('watchlist-e2e-initialized', 'true')
  })
  await openTerminalSession(request)
  const apple = await resolveUsStock(request, 'AAPL')
  const microsoft = await resolveUsStock(request, 'MSFT')
  await select(page, 'MSFT', 'Stocks', microsoft, { chooseExchange: false })

  await addUsListing(page, 'AAPL')
  const expected = {
    ticker: 'AAPL',
    canonicalSymbol: apple.canonicalSymbol,
    brokerSymbol: 'AAPL',
    type: 'stock',
    exchange: 'SMART',
    listedExchange: 'NASDAQ',
    currency: 'USD',
  }
  const stored = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('ibkr-terminal.watchlist.v2') ?? '[]'))
  await expect.poll(stored).toEqual([expect.objectContaining(expected)])
  await expect(page.getByRole('button', { name: /^Change symbol /u })).toContainText('MICROSOFT')

  await page.reload()
  await expect(
    page.getByRole('region', { name: 'Markets' }).locator('[data-watchlist-row]'),
  ).toHaveCount(1)
  await expect.poll(stored).toEqual([expect.objectContaining(expected)])
  await expect(page.getByRole('button', { name: /^Change symbol /u })).toContainText('MICROSOFT')
  await page.getByRole('region', { name: 'Markets', exact: true }).screenshot({
    path: test.info().outputPath('watchlist-selected-listing-after-reload.png'),
  })
})

test('watchlist add shows a failed resolution and allows the selected listing to be retried', async ({
  page,
  context,
  request,
}) => {
  await context.addInitScript(() => {
    if (localStorage.getItem('watchlist-e2e-initialized') !== null) return
    localStorage.setItem('ibkr-terminal.watchlist.v2', '[]')
    localStorage.setItem('watchlist-e2e-initialized', 'true')
  })
  await openTerminalSession(request)
  const apple = await resolveUsStock(request, 'AAPL')
  const microsoft = await resolveUsStock(request, 'MSFT')
  await select(page, 'MSFT', 'Stocks', microsoft, { chooseExchange: false })
  let failedRequests = 0
  const isSelectedResolution = (url: URL) => {
    const query = url.searchParams
    return (
      url.pathname === '/api/v1/ibkr/symbols/resolve' &&
      query.get('symbol') === 'AAPL' &&
      query.get('exchange') === 'SMART' &&
      query.get('primaryExchange') === 'NASDAQ' &&
      query.get('currency') === 'USD' &&
      query.get('assetClass') === 'stock'
    )
  }
  await page.route('**/api/v1/ibkr/symbols/resolve?**', async (route) => {
    if (failedRequests === 0 && isSelectedResolution(new URL(route.request().url()))) {
      failedRequests += 1
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'unavailable', message: 'Temporary watchlist resolution failure' },
        }),
      })
      return
    }
    await route.fallback()
  })
  await selectUsListing(page, 'AAPL')
  const markets = page.getByRole('region', { name: 'Markets', exact: true })
  await expect(markets.getByRole('alert')).toContainText('Temporary watchlist resolution failure')
  expect(failedRequests).toBe(1)
  await expect(markets.locator('[data-watchlist-row]')).toHaveCount(0)

  const retriedResolution = page.waitForResponse(
    (response) => response.status() === 200 && isSelectedResolution(new URL(response.url())),
  )
  await addUsListing(page, 'AAPL')
  expect(await (await retriedResolution).json()).toEqual(
    expect.objectContaining({
      canonicalSymbol: apple.canonicalSymbol,
      ticker: 'AAPL',
      type: 'stock',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      currency: 'USD',
    }),
  )
  await expect(markets.getByRole('alert')).toHaveCount(0)
  const expected = {
    ticker: 'AAPL',
    canonicalSymbol: apple.canonicalSymbol,
    brokerSymbol: 'AAPL',
    type: 'stock',
    exchange: 'SMART',
    listedExchange: 'NASDAQ',
    currency: 'USD',
  }
  const stored = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('ibkr-terminal.watchlist.v2') ?? '[]'))
  await expect.poll(stored).toEqual([expect.objectContaining(expected)])
  await expect(page.getByRole('button', { name: /^Change symbol /u })).toContainText('MICROSOFT')
  await page.reload()
  await expect(markets.locator('[data-watchlist-row]')).toHaveCount(1)
  await expect(markets.locator('[data-watchlist-row]')).toContainText('AAPL')
  await expect.poll(stored).toEqual([expect.objectContaining(expected)])
  await expect(page.getByRole('button', { name: /^Change symbol /u })).toContainText('MICROSOFT')
})
