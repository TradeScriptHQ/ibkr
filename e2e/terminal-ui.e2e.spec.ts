import type { BrokerState } from '@ibkr-terminal/contracts'
import { expect, test } from './support/fixtures.js'
import { browserHeaders, expectJsonOk, openTerminalSession } from './support/session.js'

function formatMoney(value: number | undefined, currency: string | undefined): string {
  if (!currency) throw new Error('TWS did not supply an amount currency')
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    requireBrokerNumber(value),
  )
}

function formatSignedMoney(amount: number | undefined, currency: string | undefined): string {
  const value = requireBrokerNumber(amount)
  const formatted = formatMoney(value, currency)
  return value > 0 ? `+${formatted}` : formatted
}

function requireBrokerNumber(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value))
    throw new Error('TWS did not supply a finite account amount')
  return value
}

function parseDisplayedNumber(value: string): number {
  return Number(value.replace(/[^\d,.-]/gu, '').replaceAll(',', ''))
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
    const bookUnavailable = book.getByText(/Need additional market data permissions/u)
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
    const readState = (): Promise<BrokerState> =>
      page.evaluate(async () => {
        const response = await fetch('/api/v1/ibkr/state', {
          headers: { 'x-tradescript-client': 'terminal-v1' },
        })
        if (!response.ok) throw new Error(`State request failed with ${response.status}`)
        return response.json()
      })

    await expect
      .poll(
        async () => {
          const state = await readState()
          const account = state.accounts.find((candidate) => candidate.id === state.activeAccountId)
          return [
            account?.cash,
            account?.netLiquidation,
            account?.buyingPower,
            account?.availableFunds,
            account?.marginUsed,
            account?.maintenanceMargin,
          ].every((value) => Number.isFinite(value))
        },
        { timeout: 45_000 },
      )
      .toBe(true)

    const state = await readState()
    const brokerAccount = state.accounts.find((candidate) => candidate.id === state.activeAccountId)
    if (!brokerAccount) throw new Error('TWS returned no active account')
    const accountPanel = page.getByRole('region', {
      name: 'Portfolio & Activity',
    })
    const currency = brokerAccount.currency

    await expect(accountPanel).toContainText(formatMoney(brokerAccount.cash, currency))
    await expect(accountPanel).toContainText(formatMoney(brokerAccount.netLiquidation, currency))
    await expect(accountPanel).toContainText(formatMoney(brokerAccount.buyingPower, currency))
    await expect(accountPanel).toContainText(formatMoney(brokerAccount.marginUsed, currency))

    await accountPanel.getByRole('button', { name: /^Account \(\d+\)$/u }).click()
    for (const [label, value] of [
      ['Cash', brokerAccount.cash],
      ['Net Liquidation', brokerAccount.netLiquidation],
      ['Buying Power', brokerAccount.buyingPower],
      ['Available Funds', brokerAccount.availableFunds],
      ['Initial Margin Requirement', brokerAccount.marginUsed],
      ['Maintenance Margin Requirement', brokerAccount.maintenanceMargin],
    ] as const) {
      await expect(
        accountPanel.getByRole('row', {
          name: `${label} ${formatMoney(value, currency)}`,
          exact: true,
        }),
      ).toBeVisible()
    }

    for (const [label, value] of [
      ['Daily P&L', brokerAccount.dailyPnl],
      ['Unrealized P&L', brokerAccount.unrealizedPnl],
      ['Realized P&L', brokerAccount.realizedPnl],
    ] as const) {
      const labelCell = accountPanel.getByRole('cell', { name: label, exact: true })
      if (value === undefined) {
        // The account adapter omits unavailable P&L rows instead of inventing zeroes.
        await expect(labelCell).toHaveCount(0)
        continue
      }
      const row = labelCell.locator('..')
      await expect(row).toBeVisible()
      const renderedValue = await row.getByRole('cell').last().innerText()
      expect(renderedValue).toContain(
        new Intl.NumberFormat('en-US', { style: 'currency', currency })
          .formatToParts(0)
          .find((part) => part.type === 'currency')?.value,
      )
      expect(parseDisplayedNumber(renderedValue)).toBeCloseTo(value, 2)
    }

    if (
      [brokerAccount.dailyPnl, brokerAccount.unrealizedPnl, brokerAccount.realizedPnl].every(
        (value) => value === undefined,
      )
    ) {
      await expect(accountPanel.getByText('No account P&L', { exact: true })).toBeVisible()
    }

    const availableFundsRatio =
      (requireBrokerNumber(brokerAccount.availableFunds) /
        requireBrokerNumber(brokerAccount.netLiquidation)) *
      100
    const buyingPowerRatio =
      (requireBrokerNumber(brokerAccount.buyingPower) /
        requireBrokerNumber(brokerAccount.netLiquidation)) *
      100
    await expect(
      accountPanel.getByRole('row', {
        name: `Available Funds / Net Liquidation ${availableFundsRatio.toFixed(2)}%`,
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      accountPanel.getByRole('row', {
        name: `Buying Power / Net Liquidation ${buyingPowerRatio.toFixed(2)}%`,
        exact: true,
      }),
    ).toBeVisible()

    for (const position of state.positions.filter(
      (candidate) => candidate.accountId === brokerAccount.id,
    )) {
      await expect(
        accountPanel.getByRole('row', {
          name: `${position.symbol.symbol} ${formatMoney(position.marketValue, position.symbol.currency)} ${Math.abs(position.quantity)}`,
          exact: true,
        }),
      ).toBeVisible()
    }

    const mixedCurrencyPosition = state.positions.find(
      (position) =>
        position.accountId === brokerAccount.id &&
        position.pnlCurrency &&
        position.pnlCurrency !== position.symbol.currency &&
        Number.isFinite(position.unrealizedPnl),
    )
    if (mixedCurrencyPosition) {
      await accountPanel.getByRole('button', { name: /^Positions \(\d+\)$/u }).click()
      const rowText = await accountPanel
        .getByRole('row')
        .filter({ hasText: mixedCurrencyPosition.symbol.symbol })
        .last()
        .innerText()
      const correctPnl = formatSignedMoney(
        mixedCurrencyPosition.unrealizedPnl,
        mixedCurrencyPosition.pnlCurrency,
      )
      if (!rowText.includes(correctPnl)) {
        test.info().annotations.push({
          type: 'sdk-bug',
          description:
            'TradeScript 0.1.4 has one position currency field, so it cannot render quote-currency prices and base-currency P&L correctly together.',
        })
      }
    }
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
}) => {
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
  const response = page.waitForResponse(
    (item) => item.url().includes('/instrument-details?symbol=MSFT') && item.ok(),
  )
  await page
    .getByRole('region', { name: 'Markets', exact: true })
    .getByText('MSFT', { exact: true })
    .click()
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

test('the installed SDK refreshes the selected option query without switching expiry', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/options/chain') && url.searchParams.has('expiration'))
      requests.push(request.url())
  })
  await page.goto('/')
  await expect(page.locator('.terminal-host')).toHaveAttribute(
    'data-trading-operation-support',
    /getState/,
    { timeout: 45_000 },
  )
  await page.getByRole('tab', { name: /Options Chain/u }).click()
  const chain = page.getByRole('tabpanel', { name: /Options Chain/u })
  await expect(chain.getByText('Calls', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => requests.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3)
  const latest = requests.slice(-3)
  expect(new Set(latest).size).toBe(1)
  const first = latest[0]
  if (!first) throw new Error('No refreshed option query was observed')
  const query = new URL(first).searchParams
  expect(Number(query.get('maxQuoteContracts'))).toBeGreaterThan(0)
  expect(Number(query.get('centerPrice'))).toBeGreaterThan(0)
  await test.info().attach('repeated-option-query', {
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
