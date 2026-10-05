import type { OptionChainResult } from '@ibkr-terminal/contracts'
import type { Page } from '@playwright/test'
import { currentAccountPanelMismatches } from './support/account-panel-check.js'
import { expect, test } from './support/fixtures.js'
import { resolveUsStock, select } from './support/instrument-contracts.js'
import { browserHeaders, expectJsonOk, openTerminalSession } from './support/session.js'

async function selectAppleOptionClass(page: Page) {
  const chain = page.getByRole('tabpanel', { name: /Options Chain/u })
  const selector = chain.getByRole('combobox', { name: 'Trading class', exact: true })
  await expect(selector).toBeVisible()
  await selector.click()
  const standard = page.getByRole('option', { name: /^AAPL\b/u })
  await expect(standard).toHaveCount(1)
  await standard.click()
  await expect(selector).toContainText(/^AAPL\b/u)
}

test.describe('TradeScript terminal UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-trading-operation-support',
      /getState/,
      {
        timeout: 45_000,
      },
    )
    await expect(page.getByText('Workstation unavailable')).toHaveCount(0)
  })

  test('mounts every configured workstation region with real account state', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Connection', exact: true })).toContainText(
      'Paper',
    )

    for (const regionName of [
      'Markets',
      'IBKR Chart',
      'Order Entry',
      'Portfolio & Activity',
      'Order Book',
    ]) {
      await expect(page.getByRole('region', { name: regionName })).toBeVisible()
    }
    await expect(page.getByRole('tab', { name: /Time & Sales/u })).toBeVisible()
    await expect(page.getByText('Waiting for book...', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Waiting for trades...', { exact: true })).toHaveCount(0)

    await expect(
      page.getByText(/Chart 1 of 1\. APPLE INC on SMART, 5m candles chart\./u),
    ).toBeVisible()
    await expect(page.getByText(/^Cash:$/u).first()).toBeVisible()
    await expect(page.getByText(/^Equity:$/u).first()).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'Portfolio & Activity' }).getByText('P&L:', { exact: true }),
    ).toBeVisible()
    await expect(page.getByText(/^Buying Power:$/u).first()).toBeVisible()
    await expect(page.locator('body')).toContainText(/[$€£]\s?[\d,.]+/u)
    await expect(page.getByRole('button', { name: /Positions \(\d+\)/u })).toBeVisible()
  })

  test('exercises the order ticket controls without submitting an order', async ({
    page,
    request,
  }) => {
    page.setDefaultTimeout(15_000)
    await openTerminalSession(request)
    const session = (await expectJsonOk(
      await request.get(
        '/api/v1/ibkr/sessions?symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock',
        { headers: browserHeaders },
      ),
    )) as { metadata: { quantityStep: number } }
    expect(session.metadata.quantityStep).toBeGreaterThan(0)
    const ticket = page.getByRole('region', { name: 'Order Entry' })
    await ticket.getByRole('button', { name: 'Sell', exact: true }).click()
    await expect(ticket.getByRole('button', { name: 'Sell', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await ticket.getByRole('button', { name: 'Buy', exact: true }).click()

    await ticket.getByRole('button', { name: 'LMT', exact: true }).click()
    await expect(ticket.getByRole('button', { name: 'LMT', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await ticket.getByRole('button', { name: 'STP', exact: true }).click()
    await ticket.getByRole('button', { name: 'MKT', exact: true }).click()

    const quantity = ticket.getByRole('textbox', { name: 'Qty' })
    await quantity.fill('3')
    await expect(quantity).toHaveValue('3')
    await ticket.getByRole('button', { name: 'Increase quantity' }).click()
    await expect
      .poll(async () => Number(await quantity.inputValue()))
      .toBeCloseTo(3 + session.metadata.quantityStep, 8)
    await ticket.getByRole('button', { name: 'Decrease quantity' }).click()
    await ticket.getByRole('button', { name: '10', exact: true }).click()
    await expect(quantity).toHaveValue('10')
    await ticket.getByRole('button', { name: '1', exact: true }).click()

    await ticket.getByRole('button', { name: 'Show', exact: true }).click()
    await ticket.getByRole('button', { name: 'Iceberg', exact: true }).click()
    const displaySize = ticket.getByRole('textbox', {
      name: 'Displayed quantity',
    })
    await expect(displaySize).toBeVisible()
    await displaySize.fill('1')
    await expect(displaySize).toHaveValue('1')
    const displaySizeError = ticket.getByText(
      'Displayed quantity must be smaller than total quantity.',
      { exact: true },
    )
    await expect(displaySizeError).toBeVisible()
    await quantity.fill('10')
    await expect(displaySizeError).toHaveCount(0)
    await ticket.getByRole('button', { name: 'Iceberg', exact: true }).click()
    await expect(displaySize).toBeDisabled()
    await ticket.getByRole('button', { name: 'Add exits' }).click()
    await expect(ticket.getByText(/Take profit|Stop loss/iu).first()).toBeVisible()

    await expect(ticket.getByRole('button', { name: /Buy AAPL/u })).toBeVisible()
  })

  test('offers every broker-qualified stock order type in the native ticket', async ({ page }) => {
    const ticket = page.getByRole('region', { name: 'Order Entry' })
    await ticket.getByRole('combobox', { name: 'MKT' }).click()
    await expect(page.getByRole('listbox', { name: 'MKT' })).toBeVisible()
    expect(
      await page.getByRole('listbox', { name: 'MKT' }).getByRole('option').allTextContents(),
    ).toEqual([
      'MKT',
      'LMT',
      'MIDPRICE',
      'MTL',
      'STP',
      'STP LMT',
      'TRAIL',
      'TRAIL LIMIT',
      'PEG MID',
      'MOC',
      'LOC',
      'Adaptive (IBALGO)',
      'IBALGO',
    ])
    await page.getByRole('option', { name: 'TRAIL LIMIT', exact: true }).click()
    await expect(ticket.getByRole('combobox', { name: 'TRAIL LIMIT' })).toBeVisible()
    await expect(ticket.getByRole('textbox', { name: /Limit Offset/iu })).toBeVisible()
    await expect(ticket.getByRole('textbox', { name: /Stop/iu })).toBeVisible()
    await expect(ticket.getByRole('textbox', { name: /Trail/iu })).toBeVisible()
  })

  test('mirrors broker-advertised durations in the native options ticket', async ({
    page,
    request,
  }) => {
    await openTerminalSession(request)
    const marketSession = (await expectJsonOk(
      await request.get(
        '/api/v1/ibkr/sessions?symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock',
        { headers: browserHeaders },
      ),
    )) as {
      metadata?: {
        supportedDurations?: Array<{
          label: string
          supportedOrderTypes?: string[]
        }>
      }
    }
    const brokerDurationLabels = (marketSession.metadata?.supportedDurations ?? [])
      .filter(
        (duration) =>
          duration.supportedOrderTypes === undefined ||
          duration.supportedOrderTypes.includes('limit'),
      )
      .map((duration) => duration.label)
    expect(brokerDurationLabels.length).toBeGreaterThan(2)

    await page.getByRole('tab', { name: /Options Order/u }).click()
    const ticket = page.getByRole('tabpanel', { name: /Options Order/u })
    const duration = ticket.getByRole('combobox', { name: 'Duration', exact: true })
    await duration.click()
    await expect(page.getByRole('option')).toHaveText(brokerDurationLabels)
    await page.getByRole('option', { name: 'GTD', exact: true }).click()
    await expect(ticket.getByRole('combobox', { name: 'Expiry date' })).toBeVisible()
    await expect(ticket.getByRole('combobox', { name: 'Expiry time' })).toBeVisible()
  })

  test('opens every alternate trading and analysis surface', async ({ page }) => {
    await page.getByRole('tab', { name: /Options Chain/u }).click()
    const chain = page.getByRole('tabpanel', { name: /Options Chain/u })
    await expect(chain).toBeVisible()
    await selectAppleOptionClass(page)
    await expect(chain.getByText('Calls', { exact: true })).toBeVisible({
      timeout: 60_000,
    })
    await expect(chain.getByText('Strike', { exact: true })).toBeVisible()
    await expect(chain.getByText('Puts', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: /Options Order/u }).click()
    await expect(page.getByRole('tabpanel', { name: /Options Order/u })).toBeVisible()

    await page.getByRole('tab', { name: /Price Ladder/u }).click()
    await expect(page.getByRole('tabpanel', { name: /Price Ladder/u })).toBeVisible()

    await page.getByRole('tab', { name: /Time & Sales/u }).click()
    const tape = page.getByRole('tabpanel', { name: /Time & Sales/u })
    await expect(tape).toBeVisible()
    const tapeUnavailable = tape.getByText(
      'Tick-by-tick data unavailable · IBKR live subscription required',
      { exact: true },
    )
    await expect(tape.getByText('Time', { exact: true }).or(tapeUnavailable).first()).toBeVisible()
    if (!(await tapeUnavailable.isVisible())) {
      await expect(tape.getByText('Price', { exact: true })).toBeVisible()
      await expect(tape.getByText('Size', { exact: true })).toBeVisible()
    }

    await page.getByRole('tab', { name: /Order Book/u }).click()
    const book = page.getByRole('tabpanel', { name: /Order Book/u })
    await expect(book).toBeVisible()
    const bookUnavailable = book.getByText(
      /Need additional market data permissions|Waiting for .+ market depth from IBKR\.|.+ market depth has not responded\. Availability is unknown\./u,
    )
    await expect(
      book.getByText('Best bid', { exact: true }).or(bookUnavailable).first(),
    ).toBeVisible()
    if (!(await bookUnavailable.isVisible()))
      await expect(book.getByText('Best ask', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: /IBKR Chart/u }).click()
    await page.getByRole('button', { name: 'Chart data', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('table')).toBeVisible()
    expect(await page.getByRole('dialog').getByRole('row').count()).toBeGreaterThan(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('navigates every Account Manager page', async ({ page }) => {
    const account = page.getByRole('region', { name: 'Portfolio & Activity' })
    for (const name of [
      /Positions \(\d+\)/u,
      /Orders \(\d+\)/u,
      /History \(\d+\)/u,
      /Executions \(\d+\)/u,
      /Notifications \(\d+\)/u,
      /Account \(\d+\)/u,
    ]) {
      const button = account.getByRole('button', { name })
      await button.click()
      await expect(button).toHaveClass(/ts-chart-button-active/u)
    }
    await expect(account.getByRole('button', { name: 'Export' })).toBeVisible()
    await expect(account.getByRole('button', { name: 'Columns' })).toBeVisible()
  })

  test('reconciles every current Account panel value with live broker state', async ({ page }) => {
    const accountPanel = page.getByRole('region', { name: 'Portfolio & Activity' })
    const verify = async (phase: 'summary' | 'account' | 'position-pnl') => {
      await expect
        .poll(() => page.evaluate(currentAccountPanelMismatches, phase), {
          timeout: 45_000,
          intervals: [300, 500, 1_000],
          message: 'Fresh broker, native SDK and rendered account facts must agree',
        })
        .toEqual([])
    }
    await verify('summary')
    await accountPanel.getByRole('button', { name: /^Account \(\d+\)$/u }).click()
    await verify('account')
    await accountPanel.getByRole('button', { name: /^Positions \(\d+\)$/u }).click()
    await verify('position-pnl')
  })

  test('has no horizontal document overflow at workstation and laptop sizes', async ({ page }) => {
    for (const viewport of [
      { width: 1728, height: 1117 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport)
      await page.waitForTimeout(500)
      const metrics = await page.evaluate(() => ({
        bodyWidth: document.body.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        bodyHeight: document.body.scrollHeight,
        viewportHeight: document.documentElement.clientHeight,
      }))
      expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewportWidth)
      expect(metrics.bodyHeight).toBeLessThanOrEqual(metrics.viewportHeight)
    }
  })
})

test('fundamentals can be closed and added through the workspace menu and follows the selected symbol', async ({
  page,
  request,
}) => {
  await openTerminalSession(request)
  const microsoft = await resolveUsStock(request, 'MSFT')
  await page.goto('/')
  const tab = page.getByRole('tab').filter({ hasText: 'Fundamentals' })
  await expect(tab).toBeVisible({ timeout: 60_000 })
  await tab.click()
  const panel = page
    .getByRole('tabpanel', { name: /Fundamentals/u })
    .getByRole('region', { name: 'Fundamentals', exact: true })
  await expect(panel).toContainText('APPLE INC')
  await tab.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(tab).toHaveCount(0)
  await page
    .getByRole('region', { name: 'IBKR Chart', exact: true })
    .getByRole('button', { name: 'Add widget', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Fundamentals', exact: true }).click()
  await expect(tab).toBeVisible()
  await expect(panel).toContainText('APPLE INC')
  await page.getByRole('tab', { name: /IBKR Chart/u }).click()
  const response = page.waitForResponse((item) => {
    const url = new URL(item.url())
    return (
      item.ok() &&
      url.pathname.endsWith('/instrument-details') &&
      url.searchParams.get('symbol') === (microsoft.brokerSymbol ?? microsoft.ticker) &&
      url.searchParams.get('assetClass') === microsoft.type &&
      url.searchParams.get('exchange') === microsoft.exchange &&
      url.searchParams.get('primaryExchange') === microsoft.primaryExchange &&
      url.searchParams.get('currency') === microsoft.currency
    )
  })
  await select(page, 'MSFT', 'Stocks', microsoft, { navigate: false, chooseExchange: false })
  await response
  await tab.click()
  await expect(panel).toContainText('MICROSOFT')
  await expect(panel).not.toContainText('APPLE INC')
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await panel.screenshot({ path: test.info().outputPath('fundamentals.png') })
  await page.reload()
  await tab.click()
  await expect(panel).toContainText('MICROSOFT')
  await expect(panel).not.toContainText('APPLE INC')
})

test('the native SDK streams the selected option query without switching expiry', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/options/chain/events') && url.searchParams.has('expiration'))
      requests.push(request.url())
  })
  await openTerminalSession(request)
  const calendar = await expectJsonOk<OptionChainResult>(
    await request.get(
      '/api/v1/ibkr/options/chain?underlying=AAPL&tradingClass=AAPL&includeTradingClasses=true&currency=USD&underlyingAssetClass=stock&underlyingExchange=SMART',
      { headers: browserHeaders },
    ),
  )
  const expiration = calendar.expirations
    .map((item) => item.expiration)
    .filter((date) => Date.parse(date) > Date.now() + 4 * 86400_000)
    .sort()[0]
  if (!expiration) throw new Error('No future native AAPL option expiry is available')
  await page.goto('/')
  await expect(page.locator('.terminal-host')).toHaveAttribute(
    'data-trading-operation-support',
    /getState/,
    { timeout: 45_000 },
  )
  await page.getByRole('tab', { name: /Options Chain/u }).click()
  const chain = page.getByRole('tabpanel', { name: /Options Chain/u })
  const defaultStream = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname.endsWith('/options/chain/events') &&
      url.searchParams.get('tradingClass') === 'AAPL' &&
      url.searchParams.has('expiration')
    )
  })
  await selectAppleOptionClass(page)
  const initialStream = await defaultStream
  expect(initialStream.status()).toBe(200)
  const initialExpiration = new URL(initialStream.url()).searchParams.get('expiration')
  const catalogDay = new Date().toISOString().slice(0, 10)
  const eligibleDefault = calendar.expirations
    .map((item) => item.expiration)
    .filter((date) => date > catalogDay)
    .sort()[0]
  expect(
    eligibleDefault,
    'Native date-only catalog must contain an eligible future date',
  ).toBeDefined()
  expect(
    initialExpiration,
    'Class selection must automatically stream the earliest eligible future date',
  ).toBe(eligibleDefault)
  await expect(chain.getByText('Calls', { exact: true })).toBeVisible({ timeout: 60_000 })
  const label = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(expiration))
  requests.length = 0
  const stream = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname.endsWith('/options/chain/events') &&
      url.searchParams.get('tradingClass') === 'AAPL' &&
      url.searchParams.get('expiration') === expiration
    )
  })
  await chain.getByRole('button', { name: new RegExp(`^${label}\\b`, 'u') }).click()
  const response = await stream
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('text/event-stream')
  await page.waitForTimeout(5_000)
  const latest = [...requests]
  expect(latest.length).toBeGreaterThan(0)
  expect(new Set(latest.map((url) => new URL(url).searchParams.get('expiration')))).toEqual(
    new Set([expiration]),
  )
  const first = latest[0]
  if (!first) throw new Error('No refreshed option query was observed')
  const query = new URL(first).searchParams
  expect(query.get('tradingClass')).toBe('AAPL')
  expect(Number(query.get('maxQuoteContracts'))).toBeGreaterThan(0)
  expect(Number(query.get('centerPrice'))).toBeGreaterThan(0)
  await test.info().attach('selected-option-stream', {
    body: JSON.stringify(latest),
    contentType: 'application/json',
  })
})

test('header reflects the actual gateway connection status', async ({ page }) => {
  await page.goto('/')
  const health = await page.evaluate(async () => {
    const response = await fetch('/api/v1/ibkr/health', {
      headers: { 'x-tradescript-client': 'terminal-v1' },
    })
    if (!response.ok) throw new Error('Health endpoint unavailable')
    return response.json()
  })
  const label =
    health.connectionStatus === 'connecting'
      ? 'Connecting…'
      : health.connectionStatus !== 'connected'
        ? 'TWS offline'
        : health.marketDataConnection?.status === 'disconnected'
          ? 'Market data offline'
          : health.marketDataConnection?.status === 'degraded'
            ? 'Market data disrupted'
            : 'TWS connected'
  await expect(page.getByTestId('connection-health')).toHaveText(label)
  await page.screenshot({ path: test.info().outputPath('header-actual-connection.png') })
})
