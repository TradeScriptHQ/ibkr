import { expect, test } from '../support/fixtures.js'

// The real proxy, SDK startup and paper guard remain in place. Only read-only historical
// responses are injected; account DOM, screenshots and network traces stay out of artifacts.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const fallback of ['empty', 'unavailable'] as const) {
  test(`chart data retains the current default snapshot and explains ${fallback} history`, async ({
    page,
  }) => {
    let openingDialog = false
    let startupRequests = 0
    let fallbackInterval: string | null = null
    let fallbackSymbol: string | null = null
    await page.route('**/api/v1/ibkr/bars?*', async (route) => {
      const url = new URL(route.request().url())
      if (openingDialog) {
        fallbackInterval = url.searchParams.get('interval')
        fallbackSymbol = url.searchParams.get('symbol')
        expect(await route.request().headerValue('x-tradescript-client')).toBe('terminal-v1')
        if (fallback === 'unavailable') {
          return route.fulfill({ status: 502, body: 'Injected historical data outage' })
        }
      } else {
        startupRequests += 1
      }
      return route.fulfill({ json: { bars: [], dataUnavailable: true } })
    })

    await page.goto('/')
    await expect(page.getByRole('region', { name: 'IBKR Chart', exact: true })).toBeVisible()
    const open = page.getByRole('button', { name: 'Chart data', exact: true })
    await expect(open).toBeEnabled()
    await expect.poll(() => startupRequests).toBeGreaterThan(0)
    openingDialog = true
    await open.click()

    const dialog = page.getByRole('dialog', { name: 'AAPL chart data', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('5m bars · newest first', { exact: true })).toBeVisible()
    await expect.poll(() => fallbackInterval).toBe('5m')
    await expect.poll(() => fallbackSymbol).toBe('AAPL')
    await expect(dialog.getByRole('row')).toHaveCount(1)
    if (fallback === 'unavailable') {
      await expect(
        page.getByRole('region', { name: 'Notifications', exact: true }).getByRole('alert'),
      ).toHaveText('Chart data is unavailable. Try again when the connection is ready.')
      await expect(dialog.getByText('No chart bars are available.', { exact: true })).toHaveCount(0)
    } else {
      await expect(dialog.getByText('No chart bars are available.', { exact: true })).toBeVisible()
      await expect(
        page.getByRole('region', { name: 'Notifications', exact: true }).getByRole('alert'),
      ).toHaveCount(0)
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(open).toBeEnabled()
    await page.unrouteAll({ behavior: 'wait' })
  })
}

test('chart data captures the interval selected through the chart controls', async ({ page }) => {
  let selectedInterval: string | null = null
  await page.route('**/api/v1/ibkr/bars?*', (route) => {
    selectedInterval = new URL(route.request().url()).searchParams.get('interval')
    return route.fulfill({ json: { bars: [], dataUnavailable: true } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Intervals', exact: true }).click()
  await page.getByRole('button', { name: '15m', exact: true }).last().click()
  await expect.poll(() => selectedInterval).toBe('15m')
  await page.getByRole('button', { name: 'Chart data', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AAPL chart data', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('15m bars · newest first', { exact: true })).toBeVisible()
  await expect(dialog.getByText('5m bars · newest first', { exact: true })).toHaveCount(0)
  await page.unrouteAll({ behavior: 'wait' })
})

test('chart data preserves provider-declared forex precision for synthetic historical prices', async ({
  page,
}) => {
  test.setTimeout(120_000)
  let openingDialog = false
  let forexHistoryRequests = 0
  let fallbackSymbol: string | null = null
  const syntheticBar = {
    time: Date.now() - 300_000,
    open: 1.23456,
    high: 1.23567,
    low: 1.23345,
    close: 1.23478,
    volume: 123,
  }
  await page.route('**/api/v1/ibkr/bars?*', (route) => {
    const url = new URL(route.request().url())
    const forex = url.searchParams.get('assetClass') === 'forex'
    if (forex && openingDialog) {
      fallbackSymbol = url.searchParams.get('symbol')
      return route.fulfill({ json: { bars: [syntheticBar] } })
    }
    if (forex) forexHistoryRequests += 1
    return route.fulfill({ json: { bars: [], dataUnavailable: true } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^Change symbol / }).click()
  await page.getByRole('button', { name: 'Forex', exact: true }).click()
  await page.getByPlaceholder('Symbol', { exact: true }).fill('EURUSD')
  await page
    .getByRole('listitem')
    .filter({ has: page.getByText('EURUSD', { exact: true }) })
    .first()
    .click()
  await expect.poll(() => forexHistoryRequests).toBeGreaterThan(0)
  openingDialog = true
  await page.getByRole('button', { name: 'Chart data', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'EURUSD chart data', exact: true })
  await expect(dialog).toBeVisible()
  await expect.poll(() => fallbackSymbol).toBe('EURUSD')
  const cells = dialog.getByRole('row').nth(1).getByRole('cell')
  await expect(cells.nth(1)).toHaveText('1.23456')
  await expect(cells.nth(2)).toHaveText('1.23567')
  await expect(cells.nth(3)).toHaveText('1.23345')
  await expect(cells.nth(4)).toHaveText('1.23478')
  await expect(
    page.getByRole('region', { name: 'Notifications', exact: true }).getByRole('alert'),
  ).toHaveCount(0)
  await page.unrouteAll({ behavior: 'wait' })
})
