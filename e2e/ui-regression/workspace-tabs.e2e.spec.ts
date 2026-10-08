import { APPEARANCE_STORAGE_KEY } from '../../apps/terminal/src/appearance.js'
import { expect, test } from '../support/fixtures.js'

// Tab interactions use the running SDK and paper proxy. Keep private account data out of artifacts.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const appearance of ['dark', 'light'] as const) {
  test(`workspace pill tabs support switching and closing in ${appearance} appearance`, async ({
    page,
  }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: APPEARANCE_STORAGE_KEY,
      value: appearance,
    })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    const layout = page.getByTestId('widget-layout-container')
    await expect(layout).toHaveAttribute('data-tab-appearance', 'pill')
    const chart = layout.getByRole('tab', { name: /IBKR Chart/u })
    const options = layout.getByRole('tab', { name: /Options Chain/u })
    await expect(chart).toBeVisible()
    await expect(options).toBeVisible()
    await expect(layout.getByRole('button', { name: /^Set up .* hotkeys$/u })).toHaveCount(0)

    await chart.click()
    await expect(chart).toHaveAttribute('aria-selected', 'true')
    await expect(options).toHaveAttribute('aria-selected', 'false')
    await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(options.getByRole('button', { name: 'Close', exact: true })).toHaveCSS(
      'opacity',
      '0',
    )
    const geometry = await chart.evaluate((tab) => {
      const style = getComputedStyle(tab)
      const bounds = tab.getBoundingClientRect()
      const stripElement = tab.closest('.dv-tabs-and-actions-container')
      const dot = tab.querySelector('.ts-wl-tab-indicator')
      if (!stripElement || !dot) throw new Error('Workspace tab chrome is missing')
      const strip = stripElement.getBoundingClientRect()
      const dotBounds = dot.getBoundingClientRect()
      return {
        radius: style.borderRadius,
        background: style.backgroundColor,
        topInset: bounds.top - strip.top,
        bottomInset: strip.bottom - bounds.bottom,
        dotColor: getComputedStyle(dot).backgroundColor,
        dotCenter: dotBounds.top + dotBounds.height / 2,
        tabCenter: bounds.top + bounds.height / 2,
      }
    })
    expect(geometry.radius).toBe('10px')
    expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)')
    expect(geometry.topInset).toBeGreaterThanOrEqual(3)
    expect(geometry.bottomInset).toBeGreaterThanOrEqual(3)
    expect(geometry.dotColor).toBe('rgb(47, 100, 255)')
    expect(Math.abs(geometry.dotCenter - geometry.tabCenter)).toBeLessThan(1)

    await options.click()
    await expect(options).toHaveAttribute('aria-selected', 'true')
    await expect(options.getByRole('button', { name: 'Close', exact: true })).toHaveCSS(
      'opacity',
      '1',
    )
    await expect(chart).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByRole('tabpanel', { name: /Options Chain/u })).toBeVisible()
    await options.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(options).toHaveCount(0)
    await expect(chart).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('region', { name: 'IBKR Chart', exact: true })).toBeVisible()
  })
}
