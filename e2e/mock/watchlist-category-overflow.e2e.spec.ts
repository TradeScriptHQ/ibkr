import { expect, test } from '@playwright/test'
import { loadRootEnvironment } from '../../apps/gateway/src/environment.js'

// Render the real source SDK against local simulation data. No broker, order,
// licence service, MCP bridge, or account settings are contacted by this test.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const CATEGORIES = ['All', 'Stocks', 'Crypto', 'Forex', 'Indices', 'ETF', 'Futures']

for (const viewportWidth of [1_200, 1_728]) {
  test(`watchlist category labels stay intact and scroll at ${viewportWidth}px window width`, async ({
    page,
  }) => {
    const environment = loadRootEnvironment(
      process.env,
      test.info().config.webServer?.env?.TERMINAL_ENV_FILE,
    )
    test.skip(
      !environment.TRADESCRIPT_SDK_SOURCE?.trim(),
      'Source SDK regression requires TRADESCRIPT_SDK_SOURCE; packaged SDK qualification is separate.',
    )
    test.info().annotations.push({
      type: 'qualification',
      description: 'Source SDK and synthetic simulation only; all browser APIs intercepted.',
    })
    const blockedWrites: string[] = []
    let sourceWatchlistLoaded = false
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.endsWith('/charts-pro/src/trading/widgets/WatchlistTable.tsx'))
        sourceWatchlistLoaded = true
    })
    await page.route('**/api/**', (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path === '/api/v1/session/bootstrap' && request.method() === 'POST')
        return route.fulfill({
          json: {
            csrfToken: 'synthetic-watchlist-session-token-at-least-32-characters',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        })
      if (path === '/api/v1/status' && request.method() === 'GET')
        return route.fulfill({
          json: {
            service: 'ibkr-trading-gateway',
            version: 'synthetic-watchlist-geometry',
            environment: 'paper',
            ready: true,
            tradingEnabled: false,
            generatedAt: new Date().toISOString(),
            requirements: [],
          },
        })
      if (path === '/api/v1/tradescript/bootstrap' && request.method() === 'GET')
        return route.fulfill({
          json: {
            // Source development mode allocates its own authority and consumes no lease.
            lease: 'synthetic-unused-development-lease'.repeat(3),
            leaseType: 'TradeScript-Deployment-Lease',
            sdkVersion: '0.1.34',
            customerBuildFingerprint: `tsfp1_${'a'.repeat(32)}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            renewAfter: new Date(Date.now() + 30_000).toISOString(),
            paperTrading: { enabled: false, autonomyMode: 'paper-auto', allowedAccountIds: [] },
          },
        })
      if (request.method() !== 'GET') blockedWrites.push(`${request.method()} ${path}`)
      return route.abort('blockedbyclient')
    })
    await page.route('**/mcp-local/**', (route) => route.abort('blockedbyclient'))
    try {
      await page.setViewportSize({ width: viewportWidth, height: 1_000 })
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await expect(page.getByText('Simulated session', { exact: true })).toBeVisible()
      await expect(page.locator('.terminal-frame:not(:has(.terminal-overlay))')).toBeVisible()
      expect(sourceWatchlistLoaded, 'The regression must render the actual source SDK').toBe(true)

      const watchlist = page.getByRole('tabpanel').filter({
        has: page.getByRole('button', { name: 'Add symbol', exact: true }),
      })
      await expect(watchlist).toBeVisible()
      await watchlist.getByRole('button', { name: 'Add symbol', exact: true }).click()
      await watchlist.getByPlaceholder('Search symbol', { exact: true }).fill('A')
      const lastCategory = page.getByRole('button', { name: 'Futures', exact: true })
      await expect(lastCategory).toBeAttached()
      const row = lastCategory.locator('..')
      const dropdown = row.locator('..').locator('..')
      const categories = row.getByRole('button')
      await expect(categories).toHaveText(CATEGORIES)
      await expect(dropdown.getByText('AAPL', { exact: true })).toBeAttached()

      const geometry = await categories.evaluateAll((buttons) =>
        buttons.map((button) => {
          const style = getComputedStyle(button)
          const bounds = button.getBoundingClientRect()
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
          let text = walker.nextNode()
          while (text && !text.textContent?.trim()) text = walker.nextNode()
          if (!text) throw new Error('A category pill has no visible label')
          const range = document.createRange()
          range.selectNodeContents(text)
          const label = range.getBoundingClientRect()
          const textContainer = text.parentElement
          return {
            label: button.textContent?.trim(),
            clippedPixels: textContainer
              ? textContainer.scrollWidth - textContainer.clientWidth
              : 0,
            leftOverflow:
              bounds.left +
              Number.parseFloat(style.borderLeftWidth) +
              Number.parseFloat(style.paddingLeft) -
              label.left,
            rightOverflow:
              label.right -
              bounds.right +
              Number.parseFloat(style.borderRightWidth) +
              Number.parseFloat(style.paddingRight),
          }
        }),
      )
      for (const pill of geometry) {
        expect(pill.clippedPixels, `${pill.label}: label must not be clipped`).toBeLessThanOrEqual(
          1,
        )
        expect(
          pill.leftOverflow,
          `${pill.label}: label must fit its left padding`,
        ).toBeLessThanOrEqual(1)
        expect(
          pill.rightOverflow,
          `${pill.label}: label must fit its right padding`,
        ).toBeLessThanOrEqual(1)
      }
      const rowSize = await row.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        overflow: element.scrollWidth - element.clientWidth,
      }))
      expect(rowSize.width).toBeGreaterThanOrEqual(220)
      expect(rowSize.width).toBeLessThanOrEqual(344)
      expect(
        rowSize.overflow,
        'A narrow row must scroll rather than squeeze its labels',
      ).toBeGreaterThan(20)

      // Horizontal scrolling reveals the remaining categories without shrinking labels.
      await row.hover()
      await page.mouse.wheel(600, 0)
      await expect.poll(() => row.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
      const visibleBounds = await row.evaluate((element) => {
        const viewport = element.getBoundingClientRect()
        const last = element.querySelector('button:last-child')?.getBoundingClientRect()
        if (!last) throw new Error('The last category pill disappeared')
        return { left: last.left - viewport.left, right: last.right - viewport.right }
      })
      expect(visibleBounds.left).toBeGreaterThanOrEqual(-1)
      expect(visibleBounds.right).toBeLessThanOrEqual(1)
      await lastCategory.click()
      await expect(lastCategory).toHaveClass(/(?:^|\s)ts-chart-button-active(?:\s|$)/)
      await row.hover()
      await page.mouse.wheel(-600, 0)
      const firstCategory = row.getByRole('button', { name: 'All', exact: true })
      await firstCategory.click()
      await expect(firstCategory).toHaveClass(/(?:^|\s)ts-chart-button-active(?:\s|$)/)
      await expect(lastCategory).not.toHaveClass(/(?:^|\s)ts-chart-button-active(?:\s|$)/)
      await expect(dropdown.getByText('AAPL', { exact: true })).toBeAttached()
      expect(blockedWrites, 'Category navigation must never send broker or policy writes').toEqual(
        [],
      )
    } finally {
      await page.close()
    }
  })
}
