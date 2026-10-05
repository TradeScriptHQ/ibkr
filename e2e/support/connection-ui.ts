import type { Page } from '@playwright/test'

/** UI-only qualification: expose connection controls without claiming SDK authorization. */
export async function exposeConnectionControls(page: Page): Promise<void> {
  await page.route('**/api/v1/setup', (route) =>
    route.fulfill({
      json: { sdk: { configured: true, ready: true }, connectionConfigured: true },
    }),
  )
  await page.route('**/api/v1/status', (route) =>
    route.fulfill({
      json: {
        service: 'ibkr-trading-gateway',
        version: 'connection-ui-fixture',
        environment: 'paper',
        ready: true,
        tradingEnabled: true,
        generatedAt: new Date().toISOString(),
        requirements: [],
      },
    }),
  )
  // Browser leases and broker health remain real. An unavailable SDK lease can leave
  // the chart unmounted while these independently rendered controls are exercised.
}
