import { APPEARANCE_STORAGE_KEY } from '../../apps/terminal/src/appearance.js'
import { expect, test } from '../support/fixtures.js'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const appearance of ['dark', 'light'] as const) {
  test(`workspace header actions and detached panels work in ${appearance} appearance`, async ({
    page,
  }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: APPEARANCE_STORAGE_KEY,
      value: appearance,
    })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    const chart = page.getByRole('tab', { name: /IBKR Chart/u })
    const group = page.locator('.dv-groupview').filter({ has: chart })
    const actions = group.locator('.ts-wl-group-actions')
    await expect(actions.getByRole('button')).toHaveCount(4)
    await actions.getByRole('button', { name: 'Add widget', exact: true }).click()
    await expect(page.getByTestId('widget-layout-add-widget-menu')).toBeVisible()
    await actions.getByRole('button', { name: 'Add widget', exact: true }).click()

    await expect(
      actions.getByRole('button', { name: 'Maximize', exact: true }).locator('svg'),
    ).toHaveClass(/lucide-maximize\b/u)
    await actions.getByRole('button', { name: 'Maximize', exact: true }).click()
    await expect(actions.getByRole('button', { name: 'Restore', exact: true })).toBeVisible()
    await actions.getByRole('button', { name: 'Restore', exact: true }).click()

    const sourceColor = await chart.evaluate((tab) => getComputedStyle(tab).backgroundColor)
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      actions.getByRole('button', { name: 'Open in new window', exact: true }).click(),
    ])
    await expect(popup).toHaveURL(/\/workspace-popout\.html$/u)
    const detachedChart = popup.getByRole('tab', { name: /IBKR Chart/u })
    await expect(detachedChart).toBeVisible()
    await expect(detachedChart).toHaveCSS('border-radius', '10px')
    await expect(detachedChart).toHaveCSS('background-color', sourceColor)
    await expect(popup.getByRole('banner')).toHaveCount(0)
    await expect(
      popup.getByRole('button', { name: 'Open in new window', exact: true }),
    ).toHaveCount(0)
    await expect(popup.getByRole('button', { name: 'Maximize', exact: true })).toHaveCount(0)
    await expect(popup.getByRole('region', { name: 'IBKR Chart', exact: true })).toBeVisible()
    await popup.getByRole('button', { name: 'Add widget', exact: true }).click()
    await expect(popup.getByTestId('widget-layout-add-widget-menu')).toBeVisible()
    await expect(page.getByTestId('widget-layout-add-widget-menu')).toHaveCount(0)
    await detachedChart.click()
    await expect(popup.getByTestId('widget-layout-add-widget-menu')).toHaveCount(0)
    // Match a user closing the window so Dockview receives its lifecycle event.
    await popup.close({ runBeforeUnload: true })
    await expect(chart).toBeVisible()
    await expect(
      actions.getByRole('button', { name: 'Open in new window', exact: true }),
    ).toBeVisible()

    // Close only this browser's panel group; the fixture blocks broker mutations.
    await actions.getByRole('button', { name: 'Close group', exact: true }).click()
    await expect(chart).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /Markets/u })).toBeVisible()
  })
}
