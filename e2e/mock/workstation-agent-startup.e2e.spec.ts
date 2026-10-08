import type { TradeScriptBootstrapResponse } from '@ibkr-terminal/contracts'
import { expect, test } from '@playwright/test'
import { loadRootEnvironment } from '../../apps/gateway/src/environment.js'
import { MOCK_ACCOUNT_ID } from '../../apps/terminal/src/mock/local-simulation.js'

test('the source SDK adopts verified simulated agent authority while retaining the workspace and MCP session', async ({
  page,
}) => {
  test.skip(
    !loadRootEnvironment().TRADESCRIPT_SDK_SOURCE?.trim(),
    'Requires the explicit source development SDK.',
  )
  test.info().annotations.push({
    type: 'qualification',
    description:
      'Real source SDK, simulated broker/risk data, synthetic bootstrap; no packaged authorization or IBKR qualification.',
  })
  let browserSessions = 0
  const brokerRequests: string[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.url().endsWith('/mcp-local/browser-session') && request.method() === 'POST')
      browserSessions++
    if (new URL(request.url()).pathname.startsWith('/api/v1/ibkr/'))
      brokerRequests.push(request.method())
  })
  await page.route('**/api/v1/ibkr/**', (route) => route.abort('blockedbyclient'))
  // The explicit source SDK has no lease authority. This fixture supplies only the
  // startup transport contract; the SDK and every broker/risk controller remain real.
  const bootstrap: TradeScriptBootstrapResponse = {
    lease: 'source-sdk-qualification-fixture-'.repeat(3),
    leaseType: 'TradeScript-Deployment-Lease',
    sdkVersion: '0.0.0-source-qualification',
    customerBuildFingerprint: `tsfp1_${'0'.repeat(32)}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    renewAfter: new Date(Date.now() + 30_000).toISOString(),
    paperTrading: {
      enabled: true,
      autonomyMode: 'paper-auto',
      allowedAccountIds: [MOCK_ACCOUNT_ID],
    },
  }
  await page.route('**/api/v1/tradescript/bootstrap', (route) => route.fulfill({ json: bootstrap }))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.terminal-frame:not(:has(.terminal-overlay))')).toBeVisible()
  await page.getByText('Agent Console', { exact: true }).click()
  await expect(
    page.getByRole('button', { name: /Capabilities .*paper agent trading$/ }),
  ).toBeVisible()
  await expect(page.getByText('Local MCP ready', { exact: true })).toBeVisible()
  await expect(page.locator('.agent-risk-pending')).toHaveCount(0)
  expect(browserSessions).toBe(1)
  expect(brokerRequests).toEqual([])
  expect(errors).toEqual([])
})
