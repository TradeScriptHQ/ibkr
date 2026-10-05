import type { MarketSessionInfo, MarketSymbol } from '@ibkr-terminal/contracts'
import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { select } from './support/instrument-contracts.js'
import { browserHeaders, expectJsonOk, openTerminalSession } from './support/session.js'

const sourcePages = new WeakSet<Page>()
test.beforeEach(async ({ page, request }) => {
  page.on('response', (response) => {
    if (
      response.status() === 200 &&
      new URL(response.url()).pathname.endsWith('/src/sdk/sourceDevelopmentSdk.ts')
    )
      sourcePages.add(page)
  })
  await openTerminalSession(request)
})
test.afterEach(async ({ page }) => {
  const sourceSdkLoaded = sourcePages.has(page)
  await test.info().attach('sdk-runtime-mode', {
    body: JSON.stringify({ sourceSdkLoaded }),
    contentType: 'application/json',
  })
  if (process.env.TERMINAL_E2E_SOURCE_MODE === '1') expect(sourceSdkLoaded).toBe(true)
})

async function openPriceDraft(page: Page, price: number, navigate = true) {
  if (navigate) await page.goto('/')
  await expect(page.getByRole('img', { name: /financial chart/u })).toBeVisible({
    timeout: 60_000,
  })
  await page.evaluate(async (entryPrice) => {
    const driver = window.__ibkrChartTradingE2E__
    if (!driver) throw new Error('The mounted source SDK draft driver is unavailable')
    await driver.openOrderDraft(entryPrice)
  }, price)
  await page
    .getByRole('region', { name: 'IBKR Chart', exact: true })
    .getByRole('group', { name: 'Select side' })
    .getByRole('button', { name: 'Buy', exact: true })
    .click()
  return page.getByRole('region', { name: 'Order Entry', exact: true })
}

test('mounted ticket uses the proposed-price band and keeps dragged prices on valid increments', async ({
  page,
  request,
}) => {
  let qualifiedResponses = 0
  await page.route('**/api/v1/ibkr/sessions?**', async (route) => {
    const response = await request.get(route.request().url(), { headers: browserHeaders })
    expect(response.status()).toBe(200)
    const native = await response.json()
    expect(native.symbol.canonicalSymbol).toMatch(/^IBKR:[1-9][0-9]*$/u)
    qualifiedResponses += 1
    // Only the price ladder is controlled. Native identity, connection and
    // quantity rules still come through the real read-only paper gateway.
    await route.fulfill({
      response,
      json: {
        ...native,
        symbol: {
          ...native.symbol,
          priceIncrements: [
            { lowEdge: 0, increment: 0.005 },
            { lowEdge: 10, increment: 0.25 },
          ],
        },
      },
    })
  })
  await page.goto('/')
  const chart = page.getByRole('img', { name: /financial chart/u })
  await expect(chart).toBeVisible({ timeout: 60_000 })
  const chartBox = await chart.boundingBox()
  if (!chartBox) throw new Error('The chart has no drawable bounds')
  // Price actions are available before a draft is opened. Capture a visible
  // historical price now so the later drag starts inside the actual chart.
  await page.mouse.move(chartBox.x + 4, chartBox.y + 4)
  await page.mouse.move(chartBox.x + chartBox.width * 0.7, chartBox.y + chartBox.height * 0.5, {
    steps: 12,
  })
  const action = page.getByRole('button', { name: /Open price actions at/u })
  await expect(action).toBeVisible()
  const visiblePrice = Number(
    (await action.getAttribute('aria-label'))?.match(/at\s+([\d.]+)/u)?.[1],
  )
  expect(visiblePrice).toBeGreaterThan(10)
  const ticket = await openPriceDraft(page, 333.13, false)
  const price = ticket.getByRole('textbox', { name: 'Price', exact: true })
  await price.fill('9.993')
  await price.press('Tab')
  await expect(price).toHaveValue('9.995')
  await expect(ticket.getByRole('button', { name: /LMT Buy AAPL/u })).toContainText('$9.995')
  await price.fill('333.13')
  await price.press('Tab')
  await expect(price).toHaveValue('333.25')
  await expect(ticket.getByRole('button', { name: /LMT Buy AAPL/u })).toContainText('$333.25')

  // Move the draft to that visible historical price before dragging.
  await price.fill(String(visiblePrice))
  await price.press('Tab')
  const entryLine = page.locator('[aria-label="Drag entry order line"]')
  await expect(entryLine).toBeVisible()
  const box = await entryLine.boundingBox()
  if (!box) throw new Error('The chart draft line has no draggable bounds')
  const beforeDrag = Number(await price.inputValue())
  const x = box.x + Math.min(Math.max(box.width * 0.35, 40), box.width - 40)
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 25, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => Number(await price.inputValue())).not.toBe(beforeDrag)
  const dragged = Number(await price.inputValue())
  expect(Math.abs(dragged / 0.25 - Math.round(dragged / 0.25))).toBeLessThan(1e-8)
  await expect(ticket.getByRole('button', { name: /LMT Buy AAPL/u })).toContainText(
    dragged.toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
  )
  expect(qualifiedResponses).toBeGreaterThan(0)
  await test.info().attach('price-authority-boundary', {
    body: JSON.stringify({ nativeIdentity: true, controlledPriceLadder: true, brokerMutations: 0 }),
    contentType: 'application/json',
  })
  await ticket.getByRole('button', { name: /LMT Buy AAPL/u }).screenshot({
    path: test.info().outputPath('order-price-increment.png'),
  })
})

test('mounted ticket preserves tiny ticks and the complete subcent draft-price display', async ({
  page,
  request,
}) => {
  await page.route('**/api/v1/ibkr/sessions?**', async (route) => {
    const response = await request.get(route.request().url(), { headers: browserHeaders })
    expect(response.status()).toBe(200)
    const native = await response.json()
    expect(native.symbol.canonicalSymbol).toMatch(/^IBKR:[1-9][0-9]*$/u)
    await route.fulfill({
      response,
      json: {
        ...native,
        symbol: {
          ...native.symbol,
          priceIncrements: [{ lowEdge: 0, increment: 0.000001 }],
        },
        metadata: { ...native.metadata, contractMultiplier: 1 },
      },
    })
  })
  const ticket = await openPriceDraft(page, 333.123456)
  const price = ticket.getByRole('textbox', { name: 'Price', exact: true })
  await price.fill('333.123456')
  await price.press('Tab')
  await expect(price).toHaveValue('333.123456')
  await expect(ticket.getByRole('button', { name: /LMT Buy AAPL/u })).toContainText('$333.123456')
  await expect(ticket.getByText('Tick value', { exact: true }).locator('..')).toContainText(
    '$0.000001',
  )
  await test.info().attach('price-authority-boundary', {
    body: JSON.stringify({
      nativeIdentity: true,
      controlledPriceLadderAndMultiplier: true,
      brokerMutations: 0,
    }),
    contentType: 'application/json',
  })
  await ticket.getByRole('button', { name: /LMT Buy AAPL/u }).screenshot({
    path: test.info().outputPath('subcent-price.png'),
  })
  await ticket
    .getByText('Tick value', { exact: true })
    .locator('..')
    .screenshot({
      path: test.info().outputPath('tiny-tick.png'),
    })
})

test('mounted ticket withholds money and currency labels when native quote units are unknown', async ({
  page,
  request,
}) => {
  const unavailableReason = 'Native quote-to-currency units are not verified for this contract.'
  await page.route('**/api/v1/ibkr/sessions?**', async (route) => {
    const response = await request.get(route.request().url(), { headers: browserHeaders })
    expect(response.status()).toBe(200)
    const native = await response.json()
    expect(native.symbol.canonicalSymbol).toMatch(/^IBKR:[1-9][0-9]*$/u)
    await route.fulfill({
      response,
      json: {
        ...native,
        symbol: {
          ...native.symbol,
          priceIncrements: [{ lowEdge: 0, increment: 0.25 }],
        },
        metadata: {
          ...native.metadata,
          monetaryValueAvailable: false,
          monetaryValueUnavailableReason: unavailableReason,
        },
      },
    })
  })
  const ticket = await openPriceDraft(page, 333.25)
  await expect(ticket.getByText('Trade value', { exact: true }).locator('..')).toContainText('-')
  await expect(ticket.getByText('Tick value', { exact: true }).locator('..')).toContainText('-')
  await expect(ticket.getByText(unavailableReason, { exact: true })).toBeVisible()
  const submit = ticket.getByRole('button', { name: /LMT Buy AAPL/u })
  await expect(submit).toBeDisabled()
  await expect(submit).toContainText('333.25')
  await expect(submit).not.toContainText('$333.25')
  await test.info().attach('monetary-authority-boundary', {
    body: JSON.stringify({
      nativeIdentity: true,
      controlledUnitAvailability: true,
      brokerMutations: 0,
    }),
    contentType: 'application/json',
  })
  await submit.screenshot({ path: test.info().outputPath('unknown-monetary-units.png') })
})

test('native LSE stock rules reach the mounted ticket without inventing monetary conversion', async ({
  page,
  request,
}) => {
  const query = new URLSearchParams({
    symbol: 'SPX',
    exchange: 'LSE',
    primaryExchange: 'LSE',
    currency: 'GBP',
    assetClass: 'stock',
  })
  const symbol = await expectJsonOk<MarketSymbol>(
    await request.get(`/api/v1/ibkr/symbols/resolve?${query}`, { headers: browserHeaders }),
  )
  expect(symbol.contractIdentity?.securityType).toBe('STK')
  expect(symbol.primaryExchange).toBe('LSE')
  expect(symbol.currency).toBe('GBP')
  expect(symbol.name).toBe('SPIRAX GROUP PLC')
  expect(symbol.canonicalSymbol).toMatch(/^IBKR:[1-9][0-9]*$/u)
  if (!symbol.canonicalSymbol) throw new Error('Native listing identity unavailable')
  query.set('symbol', symbol.canonicalSymbol)
  query.set('routingDestination', 'LSE')
  const session = await expectJsonOk<MarketSessionInfo>(
    await request.get(`/api/v1/ibkr/sessions?${query}`, { headers: browserHeaders }),
  )
  expect(session.metadata?.monetaryValueAvailable).toBe(false)
  const reason = session.metadata?.monetaryValueUnavailableReason
  expect(reason).toBeTruthy()
  const bands = session.symbol.priceIncrements
  expect(bands?.length).toBeGreaterThan(0)
  const priceBefore = 7250.89532
  const applicable = [...(bands ?? [])].reverse().find((band) => priceBefore >= band.lowEdge)
  expect(applicable).toBeDefined()
  if (!applicable || !reason) throw new Error('Native rule or monetary-unit diagnosis unavailable')
  const normalized = Math.round(priceBefore / applicable.increment) * applicable.increment
  await select(page, 'SPX', 'Stocks', symbol, { chooseExchange: false })
  const ticket = await openPriceDraft(page, priceBefore)
  const input = ticket.getByRole('textbox', { name: 'Price', exact: true })
  await input.fill(String(priceBefore))
  await input.press('Tab')
  await expect.poll(async () => Number(await input.inputValue())).toBe(normalized)
  await expect(ticket.getByText(reason, { exact: true })).toBeVisible()
  await expect(ticket.getByText('Trade value', { exact: true }).locator('..')).toContainText('-')
  await expect(ticket.getByText('Tick value', { exact: true }).locator('..')).toContainText('-')
  const submit = ticket.getByRole('button', { name: /LMT Buy SPX/u })
  await expect(submit).toBeDisabled()
  await expect(submit).not.toContainText('£')
  await test.info().attach('native-authority-boundary', {
    body: JSON.stringify({
      nativeExactListing: 'SPIRAX GROUP PLC / STK / GBP / LSE',
      nativeApplicableIncrement: applicable.increment,
      nativeMonetaryValueAvailable: false,
      controlledProviderResponses: false,
      independentMonetaryConversion: 'not established',
      brokerMutations: 0,
    }),
    contentType: 'application/json',
  })
  await submit.screenshot({ path: test.info().outputPath('native-lse-unit-guard.png') })
})
