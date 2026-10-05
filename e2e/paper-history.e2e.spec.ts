import { expect, test } from './support/fixtures.js'
import { FORECAST_SEARCH_ROOT, selectForecastPair } from './support/forecast-contracts.js'
import { discover, resolveUsStock, select } from './support/instrument-contracts.js'
import { openTerminalSession } from './support/session.js'

for (const instrument of [
  { name: 'mutual fund', root: 'VINIX', asset: 'fund', label: 'Mutual funds', venue: 'FUNDSERV' },
  {
    name: 'ForecastEx',
    root: FORECAST_SEARCH_ROOT,
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
    const rows = await discover(request, instrument.root, instrument.asset, instrument.venue)
    const selected =
      instrument.asset === 'event-contract' ? selectForecastPair(rows).selected : rows[0]
    if (!selected?.canonicalSymbol)
      throw new Error('TWS history contract discovery omitted canonical identity')
    const apple = await resolveUsStock(request, 'AAPL')
    await page.goto('/')
    const chart = page.getByRole('region', { name: 'IBKR Chart', exact: true })
    const close = chart.getByTestId('chart-ohlc-close-value')
    await select(page, 'AAPL', 'Stocks', apple, { navigate: false, chooseExchange: false })
    await expect(close).toHaveText(/\d/, { timeout: 45_000 })

    const unavailableResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname.endsWith('/bars') &&
        url.searchParams.get('symbol') === selected.canonicalSymbol &&
        url.searchParams.get('assetClass') === selected.type &&
        url.searchParams.get('exchange') === selected.exchange &&
        url.searchParams.get('currency') === selected.currency
      )
    })
    await select(page, selected.canonicalSymbol, instrument.label, selected, { navigate: false })
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
      return (
        url.pathname.endsWith('/bars') &&
        url.searchParams.get('symbol') === (apple.brokerSymbol ?? apple.ticker) &&
        url.searchParams.get('assetClass') === apple.type &&
        url.searchParams.get('exchange') === apple.exchange &&
        url.searchParams.get('primaryExchange') === apple.primaryExchange &&
        url.searchParams.get('currency') === apple.currency
      )
    })
    await select(page, 'AAPL', 'Stocks', apple, { navigate: false, chooseExchange: false })
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
