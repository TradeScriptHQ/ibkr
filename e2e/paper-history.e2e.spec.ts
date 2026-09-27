import { expect, test } from './support/fixtures.js'
import { discover, select } from './support/instrument-contracts.js'
import { openTerminalSession } from './support/session.js'

const now = new Date()
const forecastRoot = `FF ${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`

for (const instrument of [
  { name: 'mutual fund', root: 'VINIX', asset: 'fund', label: 'Mutual funds', venue: 'FUNDSERV' },
  {
    name: 'ForecastEx',
    root: forecastRoot,
    asset: 'event-contract',
    label: 'Forecast contracts',
    venue: 'FORECASTX',
  },
]) {
  test(`${instrument.name}: unavailable chart history clears prices and recovers on symbol switch`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await openTerminalSession(request)
    const selected = (
      await discover(request, instrument.root, instrument.asset, instrument.venue)
    )[0]!
    await page.goto('/')
    const chart = page.getByRole('region', { name: 'IBKR Chart', exact: true })
    const close = chart.getByTestId('chart-ohlc-close-value')
    await page
      .getByRole('region', { name: 'Markets', exact: true })
      .getByText('AAPL', { exact: true })
      .click({ timeout: 60_000 })
    await expect(close).toHaveText(/\d/, { timeout: 45_000 })

    const unavailableResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname.endsWith('/bars') &&
        url.searchParams.get('symbol') === selected.canonicalSymbol
      )
    })
    await select(page, selected.canonicalSymbol!, instrument.label, selected)
    const response = await unavailableResponse
    expect(response.ok()).toBe(true)
    expect(await response.json()).toMatchObject({ bars: [], dataUnavailable: true })
    await expect(chart.getByTestId('chart-history-unavailable')).toBeVisible({ timeout: 45_000 })
    await expect(close).toHaveText('')
    await expect(chart.getByTestId('chart-ohlc-open-value')).toHaveText('')
    await chart.screenshot({
      path: `.local/paper-inspection/history-verified-${instrument.asset}.png`,
    })

    const populatedResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/bars') && url.searchParams.get('symbol') === 'AAPL'
    })
    await page
      .getByRole('region', { name: 'Markets', exact: true })
      .getByText('AAPL', { exact: true })
      .click()
    const populated = await populatedResponse
    expect(populated.ok()).toBe(true)
    expect((await populated.json()).bars.length).toBeGreaterThan(0)
    await expect(chart.getByTestId('chart-history-unavailable')).toHaveCount(0)
    await expect(close).toHaveText(/\d/, { timeout: 45_000 })
    await expect(chart.getByTestId('chart-renderer-viewport')).not.toHaveAttribute(
      'aria-busy',
      'true',
    )
    await chart.screenshot({
      path: `.local/paper-inspection/history-recovered-${instrument.asset}.png`,
    })
  })
}
