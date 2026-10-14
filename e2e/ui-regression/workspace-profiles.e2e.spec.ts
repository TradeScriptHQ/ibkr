import { WORKSPACE_PROFILES_STORAGE_KEY } from '../../apps/terminal/src/workspace-profiles.js'
import { expect, test } from '../support/fixtures.js'

// Exercise the running terminal and paper provider without placing or changing orders.
// Account details never belong in screenshots, traces, or assertion output.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

test('five presets switch in place and keep order entry on the right', async ({ page }) => {
  const reconnects: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/connection\/(?:connect|retry)$/u.test(new URL(request.url()).pathname)
    )
      reconnects.push('reconnect')
  })
  await page.goto('/')
  const trigger = page.getByRole('button', { name: /^Layouts:/u })
  await expect(trigger).toBeEnabled()
  reconnects.length = 0
  for (const [name, primary] of [
    ['Options', 'Options Chain'],
    ['Active Trading', 'Price Ladder'],
    ['Chart Analysis', 'IBKR Chart'],
    ['Portfolio', 'Portfolio & Activity'],
    ['Stocks', 'IBKR Chart'],
  ] as const) {
    await trigger.click()
    await page
      .getByRole('dialog', { name: 'Layouts', exact: true })
      .getByRole('button', { name, exact: true })
      .click()
    await expect(trigger).toBeEnabled()
    await expect(trigger).toHaveAccessibleName(new RegExp(`^Layouts: ${name}`, 'u'))
    await expect(
      page.getByRole('tab', { name: new RegExp(`^${primary} Close$`, 'u') }),
    ).toHaveAttribute('aria-selected', 'true')
    const chartGroup = page
      .locator('.dv-groupview')
      .filter({ has: page.getByTestId('widget-layout-tab-chart') })
    const orderGroup = page
      .locator('.dv-groupview')
      .filter({ has: page.getByTestId('widget-layout-tab-order-ticket') })
    const chart = await chartGroup.boundingBox()
    const order = await orderGroup.boundingBox()
    expect(chart).not.toBeNull()
    expect(order).not.toBeNull()
    expect(order?.x).toBeGreaterThan((chart?.x ?? 0) + (chart?.width ?? 0) - 2)
    expect(order?.width).toBeGreaterThan(250)
    if (name === 'Active Trading') {
      await expect(page.getByRole('tab', { name: /^Order Book Close$/u })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      await expect(page.getByRole('tab', { name: /^Time & Sales Close$/u })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    }
    if (name === 'Portfolio') {
      const account = await page
        .locator('.dv-groupview')
        .filter({ has: page.getByTestId('widget-layout-tab-account') })
        .boundingBox()
      expect(account?.height).toBeGreaterThan((chart?.height ?? 0) * 1.8)
    }
  }
  expect(reconnects).toEqual([])
})

test('custom layouts save panel changes, restore after reload, and support rename and delete', async ({
  page,
}) => {
  await page.goto('/')
  const trigger = page.getByRole('button', { name: /^Layouts:/u })
  await expect(trigger).toBeEnabled()
  const fundamentals = page.getByTestId('widget-layout-tab-fundamentals')
  await fundamentals.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(fundamentals).toHaveCount(0)
  await trigger.click()
  await page.getByRole('button', { name: 'Save as new layout…', exact: true }).click()
  const saveDialog = page.getByRole('dialog', { name: 'Save layout', exact: true })
  await saveDialog.getByLabel('Layout name').fill('Test options desk')
  await saveDialog.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(trigger).toHaveAccessibleName('Layouts: Test options desk')
  await page.reload()
  await expect(trigger).toBeEnabled()
  await expect(trigger).toHaveAccessibleName('Layouts: Test options desk')
  await expect(fundamentals).toHaveCount(0)

  // A selected tab is part of the saved arrangement; explicit Save changes updates it.
  await page.getByTestId('widget-layout-tab-option-chain').click()
  await expect(trigger).toHaveAccessibleName('Layouts: Test options desk, unsaved changes')
  await trigger.click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(trigger).toHaveAccessibleName('Layouts: Test options desk')
  await trigger.click()
  await page
    .getByRole('dialog', { name: 'Layouts', exact: true })
    .getByRole('button', { name: 'Active Trading', exact: true })
    .click()
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await page
    .getByRole('dialog', { name: 'Layouts', exact: true })
    .getByRole('button', { name: 'Test options desk', exact: true })
    .click()
  await expect(page.getByRole('tab', { name: /^Options Chain Close$/u })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(fundamentals).toHaveCount(0)
  await trigger.click()
  await page.getByRole('button', { name: 'Rename…', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename layout', exact: true })
  await rename.getByLabel('Layout name').fill('Test renamed desk')
  await rename.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(trigger).toHaveAccessibleName('Layouts: Test renamed desk')
  await trigger.click()
  await page.getByRole('button', { name: 'Delete…', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Delete layout', exact: true })
    .getByRole('button', { name: 'Delete layout', exact: true })
    .click()
  await expect(trigger).toBeEnabled()
  await expect(trigger).toHaveAccessibleName(/^Layouts: Stocks/u)
  await trigger.click()
  await expect(page.getByRole('button', { name: 'Test renamed desk', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Reset preset…', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Reset preset', exact: true })
    .getByRole('button', { name: 'Reset preset', exact: true })
    .click()
  await expect(trigger).toBeEnabled()
  await expect(fundamentals).toBeVisible()
})

test('Options quotes open an exact contract chart at 40% beside the chain', async ({ page }) => {
  await page.goto('/')
  const trigger = page.getByRole('button', { name: /^Layouts:/u })
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await page
    .getByRole('dialog', { name: 'Layouts', exact: true })
    .getByRole('button', { name: 'Options', exact: true })
    .click()
  await expect(trigger).toBeEnabled()
  const chain = page.getByRole('tabpanel', { name: /Options Chain/u })
  const tradingClass = chain.getByRole('combobox', { name: 'Trading class', exact: true })
  if (await tradingClass.isVisible()) {
    await tradingClass.click()
    await page
      .getByRole('listbox')
      .getByRole('option', { name: /^[A-Z.]+ · SMART · 100$/u })
      .click()
  }
  const quotes = chain.getByRole('button', { name: /^\d+\.\d+$/u })
  await expect(quotes.first()).toBeEnabled()
  const markets = page
    .locator('.dv-groupview')
    .filter({ has: page.getByTestId('widget-layout-tab-watchlist') })
  const leftWidth = (await markets.boundingBox())?.width ?? 0
  await quotes.nth(Math.floor((await quotes.count()) / 2)).click()
  const chart = page.getByTestId('terminal-contract-chart')
  await expect(chart).toHaveAttribute('data-contract-id', /^IBKR:\d+$/u)
  await expect(chain).toBeVisible()
  const chartGroup = page.locator('.dv-groupview').filter({ has: chart })
  const chainGroup = page
    .locator('.dv-groupview')
    .filter({ has: page.getByTestId('widget-layout-tab-option-chain') })
  const chartBounds = await chartGroup.boundingBox()
  const chainBounds = await chainGroup.boundingBox()
  const order = await page
    .locator('.dv-groupview')
    .filter({ has: page.getByTestId('widget-layout-tab-option-ticket') })
    .boundingBox()
  if (!chartBounds || !chainBounds || !order) throw new Error('Option analysis panels are missing')
  expect(chartBounds.width / (chartBounds.width + chainBounds.width)).toBeGreaterThan(0.37)
  expect(chartBounds.width / (chartBounds.width + chainBounds.width)).toBeLessThan(0.43)
  expect(chartBounds.x + chartBounds.width).toBeLessThanOrEqual(order.x + 2)
  await chartGroup.getByRole('button', { name: 'Close group', exact: true }).click()
  await expect(chart).toHaveCount(0)
  await expect
    .poll(async () => Math.abs(((await markets.boundingBox())?.width ?? 0) - leftWidth))
    .toBeLessThan(2)
  await expect
    .poll(async () => (await chainGroup.boundingBox())?.width)
    .toBeGreaterThan(chainBounds.width + chartBounds.width - 8)
})

test('native splitter sizes survive saving, switching, viewport resizing, and reload', async ({
  page,
}) => {
  await page.goto('/')
  const trigger = page.getByRole('button', { name: /^Layouts:/u })
  await expect(trigger).toBeEnabled()
  const markets = page
    .locator('.dv-groupview')
    .filter({ has: page.getByTestId('widget-layout-tab-watchlist') })
  const before = await markets.boundingBox()
  if (!before) throw new Error('Markets panel is missing')
  await page.mouse.move(before.x + before.width + 4, before.y + 150)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width + 74, before.y + 150, { steps: 10 })
  await page.mouse.up()
  await expect
    .poll(async () => (await markets.boundingBox())?.width)
    .toBeGreaterThan(before.width + 40)
  const editedWidth = (await markets.boundingBox())?.width ?? 0
  await trigger.click()
  await page.getByRole('button', { name: 'Save as new layout…', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Save layout', exact: true })
    .getByLabel('Layout name')
    .fill('Test resized desk')
  await page
    .getByRole('dialog', { name: 'Save layout', exact: true })
    .getByRole('button', { name: 'Save layout', exact: true })
    .click()
  await trigger.click()
  await page
    .getByRole('dialog', { name: 'Layouts', exact: true })
    .getByRole('button', { name: 'Portfolio', exact: true })
    .click()
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await page
    .getByRole('dialog', { name: 'Layouts', exact: true })
    .getByRole('button', { name: 'Test resized desk', exact: true })
    .click()
  await expect
    .poll(async () => Math.abs(((await markets.boundingBox())?.width ?? 0) - editedWidth))
    .toBeLessThan(4)
  await page.setViewportSize({ width: 1_280, height: 900 })
  await expect.poll(async () => (await markets.boundingBox())?.width).toBeGreaterThan(1_280 * 0.23)
  await page.setViewportSize({ width: 1_728, height: 1_117 })
  await page.reload()
  await expect(trigger).toBeEnabled()
  await expect
    .poll(async () => Math.abs(((await markets.boundingBox())?.width ?? 0) - editedWidth))
    .toBeLessThan(4)
})

test('keyboard navigation and corrupted local storage leave usable presets', async ({ page }) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, '{invalid'),
    WORKSPACE_PROFILES_STORAGE_KEY,
  )
  await page.goto('/')
  const trigger = page.getByRole('button', { name: /^Layouts:/u })
  await expect(trigger).toBeEnabled()
  await trigger.press('ArrowDown')
  const menu = page.getByRole('dialog', { name: 'Layouts', exact: true })
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: 'Options', exact: true }).focus()
  await menu.getByRole('button', { name: 'Options', exact: true }).press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
