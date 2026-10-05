import { expect, type Locator, type Page, test } from '@playwright/test'

async function openSimulation(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Simulated session', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'IBKR Chart', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Chart data', exact: true })).toBeEnabled()
}

async function expectAppearance(page: Page, appearance: 'light' | 'dark', chartCount = 1) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
  await expect(page.getByRole('button', { name: 'Light mode', exact: true })).toHaveAttribute(
    'aria-pressed',
    String(appearance === 'light'),
  )
  await expect(page.getByRole('button', { name: 'Light mode', exact: true })).toHaveAttribute(
    'title',
    appearance === 'light' ? 'Switch to dark mode' : 'Switch to light mode',
  )
  await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toHaveCount(0)
  const charts = page.getByRole('region', { name: 'IBKR Chart', exact: true })
  await expect(charts).toHaveCount(chartCount)
  for (let index = 0; index < chartCount; index += 1) {
    await expect(charts.nth(index).locator('[data-theme]').first()).toHaveAttribute(
      'data-theme',
      appearance,
    )
  }
}

async function textLuminance(locator: Locator) {
  return locator.evaluate((element) => {
    const channels = getComputedStyle(element)
      .color.match(/[\d.]+/gu)
      ?.slice(0, 3)
      .map(Number)
    if (channels?.length !== 3) throw new Error('Rendered chart text has no RGB color')
    const linear = channels.map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722
  })
}

test('appearance updates the mounted chart while preserving the selected instrument', async ({
  page,
}) => {
  const brokerRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/ibkr/'))
      brokerRequests.push(request.url())
  })
  await openSimulation(page)
  await expectAppearance(page, 'dark')

  await page.getByRole('button', { name: /^Change symbol /u }).click()
  await page.getByPlaceholder('Symbol', { exact: true }).fill('MSFT')
  await page
    .getByRole('listitem')
    .filter({ has: page.getByText('MSFT', { exact: true }) })
    .first()
    .click()

  const chart = page.getByRole('region', { name: 'IBKR Chart', exact: true })
  const selectedSymbol = chart.getByRole('button', { name: /^Change symbol MSFT/u })
  await expect(selectedSymbol).toBeVisible()
  const chartNode = await chart.elementHandle()
  const canvas = chart.locator('canvas').first()
  await expect(canvas).toBeVisible()
  const canvasNode = await canvas.elementHandle()
  if (chartNode === null || canvasNode === null) throw new Error('The chart did not mount')
  const darkText = await textLuminance(selectedSymbol)

  await page.getByRole('button', { name: 'Light mode', exact: true }).click()
  await expectAppearance(page, 'light')
  await expect(selectedSymbol).toBeVisible()
  await expect.poll(() => textLuminance(selectedSymbol)).toBeLessThan(darkText)
  expect(await chartNode.evaluate((element) => element.isConnected)).toBe(true)
  expect(await canvasNode.evaluate((element) => element.isConnected)).toBe(true)
  const lightText = await textLuminance(selectedSymbol)

  await page.getByRole('button', { name: 'Light mode', exact: true }).click()
  await expectAppearance(page, 'dark')
  await expect(selectedSymbol).toBeVisible()
  await expect.poll(() => textLuminance(selectedSymbol)).toBeGreaterThan(lightText)
  expect(await chartNode.evaluate((element) => element.isConnected)).toBe(true)
  expect(await canvasNode.evaluate((element) => element.isConnected)).toBe(true)
  expect(
    brokerRequests,
    'Appearance in simulation must not call broker data or order routes',
  ).toEqual([])
})

test('both appearance choices persist after reloading the workstation', async ({ page }) => {
  await openSimulation(page)
  for (const appearance of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: 'Light mode', exact: true }).click()
    await expectAppearance(page, appearance)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: 'Chart data', exact: true })).toBeEnabled()
    await expectAppearance(page, appearance)
  }
})

test('the toolbar and appearance controls fit compact and narrow windows', async ({ page }) => {
  await openSimulation(page)
  for (const width of [900, 320]) {
    await page.setViewportSize({ width, height: 900 })
    const toolbar = page.getByRole('banner')
    await expect(toolbar).toBeVisible()
    await expect
      .poll(() => toolbar.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1)
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1)

    for (const name of ['Light mode', 'Chart data']) {
      const control = toolbar.getByRole('button', { name, exact: true })
      await expect(control).toBeVisible()
      const bounds = await control.boundingBox()
      if (bounds === null) throw new Error(`${name} has no visible bounds`)
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    }
    await toolbar.getByRole('button', { name: 'Light mode', exact: true }).click()
    await expectAppearance(page, 'light')
    await toolbar.getByRole('button', { name: 'Light mode', exact: true }).click()
    await expectAppearance(page, 'dark')
  }
})

test('appearance changes both existing charts after adding a second chart', async ({ page }) => {
  await openSimulation(page)
  await page
    .getByRole('region', { name: 'Markets', exact: true })
    .getByRole('button', { name: 'Add widget', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'IBKR Chart', exact: true }).click()
  await expectAppearance(page, 'dark', 2)

  const charts = page.getByRole('region', { name: 'IBKR Chart', exact: true })
  const mounted = []
  for (let index = 0; index < 2; index += 1) {
    const chart = charts.nth(index)
    await expect(chart).toBeVisible()
    const canvas = chart.locator('canvas').first()
    await expect(canvas).toBeVisible()
    const chartNode = await chart.elementHandle()
    const canvasNode = await canvas.elementHandle()
    if (chartNode === null || canvasNode === null) throw new Error('Both charts must be mounted')
    const symbol = chart.getByRole('button', { name: /^Change symbol /u })
    const symbolName = await symbol.getAttribute('aria-label')
    if (symbolName === null) throw new Error('Each chart must identify its selected symbol')
    mounted.push({
      chartNode,
      canvasNode,
      symbol,
      symbolName,
      darkText: await textLuminance(symbol),
    })
  }

  await page.getByRole('button', { name: 'Light mode', exact: true }).click()
  await expectAppearance(page, 'light', 2)
  const lightText = []
  for (const chart of mounted) {
    await expect(chart.symbol).toHaveAttribute('aria-label', chart.symbolName)
    await expect.poll(() => textLuminance(chart.symbol)).toBeLessThan(chart.darkText)
    expect(await chart.chartNode.evaluate((element) => element.isConnected)).toBe(true)
    expect(await chart.canvasNode.evaluate((element) => element.isConnected)).toBe(true)
    lightText.push(await textLuminance(chart.symbol))
  }

  await page.getByRole('button', { name: 'Light mode', exact: true }).click()
  await expectAppearance(page, 'dark', 2)
  for (const [index, chart] of mounted.entries()) {
    await expect(chart.symbol).toHaveAttribute('aria-label', chart.symbolName)
    const light = lightText[index]
    if (light === undefined) throw new Error('The light palette was not captured for both charts')
    await expect.poll(() => textLuminance(chart.symbol)).toBeGreaterThan(light)
    expect(await chart.chartNode.evaluate((element) => element.isConnected)).toBe(true)
    expect(await chart.canvasNode.evaluate((element) => element.isConnected)).toBe(true)
  }
})
