import { exposeConnectionControls } from '../support/connection-ui.js'
import { expect, test } from '../support/fixtures.js'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

test.beforeEach(async ({ page }) => {
  test.info().annotations.push({
    type: 'qualification',
    description: 'Synthetic SDK readiness exposes controls; health still uses the real proxy.',
  })
  await exposeConnectionControls(page)
})

test('discovers accounts in the connection dialog and invalidates an edited endpoint', async ({
  page,
}) => {
  let succeeds = true
  let failureMessage = 'Could not connect to TWS.'
  await page.route('**/api/v1/connection/test', (route) =>
    route.fulfill({
      status: succeeds ? 200 : 502,
      json: succeeds
        ? { testId: 'test-proof', accounts: ['DU-example'] }
        : { error: { message: failureMessage } },
    }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connection', exact: true })
  await expect(dialog.getByText('Allowed accounts', { exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('spinbutton', { name: 'Port', exact: true })).toBeHidden()
  await expect(dialog.getByRole('spinbutton', { name: 'Client ID', exact: true })).toBeHidden()
  const apply = dialog.getByRole('button', { name: 'Apply and connect' })
  await expect(apply).toBeDisabled()
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(
    page
      .getByRole('region', { name: 'Notifications', exact: true })
      .getByText('Connection successful.'),
  ).toBeVisible()
  await expect(dialog.getByText(/Accounts from (?:TWS|IB Gateway): DU-example/u)).toBeVisible()
  await expect(apply).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('connection-discovered.png') })
  await dialog.getByText('Advanced settings', { exact: true }).click()
  await expect(dialog.getByRole('spinbutton', { name: 'Client ID', exact: true })).toBeVisible()
  const port = dialog.getByRole('spinbutton', { name: 'Port', exact: true })
  await port.fill((await port.inputValue()) === '4002' ? '7497' : '4002')
  await expect(apply).toBeDisabled()
  succeeds = false
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(
    page
      .getByRole('region', { name: 'Notifications', exact: true })
      .getByRole('alert')
      .filter({ hasText: /Connection settings|Could not connect|Client ID/u }),
  ).toHaveText('Could not connect to TWS.')
  await expect(apply).toBeDisabled()
  await dialog.getByText('Advanced settings', { exact: true }).click()
  failureMessage = 'Client ID is already in use.'
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(dialog.getByRole('spinbutton', { name: 'Client ID', exact: true })).toBeVisible()
  await expect(
    page
      .getByRole('region', { name: 'Notifications', exact: true })
      .getByRole('alert')
      .filter({ hasText: /Connection settings|Could not connect|Client ID/u }),
  ).toHaveText(failureMessage)
})

test('header shows TWS, upstream data and gateway outages and recovery', async ({ page }) => {
  let phase: 'healthy' | 'tws' | 'data' | 'farm' | 'gateway' = 'healthy'
  await page.route('**/api/v1/ibkr/health', async (route) => {
    if (phase === 'gateway') return route.abort('connectionrefused')
    const response = await route.fetch()
    const health = await response.json()
    await route.fulfill({
      json: {
        ...health,
        connectionType: 'tws',
        connectionStatus: phase === 'tws' ? 'disconnected' : 'connected',
        marketDataConnection: {
          status: phase === 'data' ? 'disconnected' : phase === 'farm' ? 'degraded' : 'connected',
          message: 'Injected connectivity event for UI verification',
        },
      },
    })
  })
  await page.goto('/')
  const status = page.getByTestId('connection-health')
  await expect(status).toHaveText('TWS connected')
  for (const [next, label] of [
    ['tws', 'TWS offline'],
    ['data', 'Market data offline'],
    ['farm', 'Market data disrupted'],
    ['gateway', 'Terminal backend offline'],
    ['healthy', 'TWS connected'],
  ] as const) {
    phase = next
    await expect(status).toHaveText(label, { timeout: 10_000 })
    if (next === 'data')
      await page.screenshot({ path: test.info().outputPath('header-market-data-offline.png') })
  }
})

test('shows confirmed client-ID rejection, retry timing and Gateway guidance', async ({ page }) => {
  let recovered = false
  await page.route('**/api/v1/status', (route) =>
    route.fulfill({
      json: {
        service: 'ibkr-trading-gateway',
        version: 'connection-ui-fixture',
        environment: 'paper',
        ready: recovered,
        tradingEnabled: recovered,
        generatedAt: new Date().toISOString(),
        requirements: [
          {
            id: 'tws-session',
            label: 'IB Gateway paper session',
            state: recovered ? 'ready' : 'disconnected',
            message: recovered ? 'Broker state restored.' : 'Client ID already in use.',
            requiredForTrading: true,
            connection: {
              connectionType: 'ib-gateway',
              clientId: 35299,
              ...(!recovered
                ? {
                    issue: 'client-id-in-use',
                    retry: {
                      attempt: 3,
                      maxAttempts: 5,
                      exhausted: false,
                      nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
                    },
                  }
                : {}),
            },
          },
        ],
      },
    }),
  )
  await page.route('**/api/v1/ibkr/health', (route) =>
    route.fulfill({
      json: {
        ok: recovered,
        mode: 'paper',
        connectionType: 'ib-gateway',
        ibkrHost: '127.0.0.1',
        ibkrPort: 4002,
        backendPort: 3001,
        connectionStatus: recovered ? 'connected' : 'disconnected',
      },
    }),
  )
  await page.goto('/')
  const status = page.getByTestId('connection-health')
  await expect(status).toHaveText('IB Gateway retrying')
  await status.click()
  const details = page.getByRole('dialog', { name: 'Broker connection status' })
  await expect(details).toBeVisible()
  await expect(details).toContainText(
    'IB Gateway rejected client ID 35299 because it is already in use.',
  )
  await expect(details).not.toContainText('Open IB Gateway')
  await expect(details).toContainText(/Retrying in \d+ seconds \(3 of 5\)/u)
  await expect(details).not.toContainText('No Internet connection')
  await details.getByRole('button', { name: 'Close connection status' }).click()
  await expect(details).toBeHidden()
  await status.click()
  await expect(details).toBeVisible()
  recovered = true
  await expect(status).toHaveText('IB Gateway connected', { timeout: 10_000 })
  await expect(details).not.toContainText('already in use')
  await expect(details).not.toContainText('Retrying in')
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
})

test.describe('connection settings poll recovery', () => {
  test('clears a transient polling error after the next successful settings read', async ({
    page,
  }) => {
    let unavailable = false
    let injectedFailures = 0
    const writes: string[] = []
    await page.route('**/api/v1/connection', async (route) => {
      if (route.request().method() !== 'GET') {
        writes.push(route.request().method())
        return route.fallback()
      }
      if (!unavailable) return route.fallback()
      injectedFailures += 1
      return route.fulfill({ status: 502, body: 'Injected settings poll outage' })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Connection', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Connection', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Apply and connect' })).toBeDisabled()
    await expect(
      page
        .getByRole('region', { name: 'Notifications', exact: true })
        .getByRole('alert')
        .filter({ hasText: /Connection settings|Could not connect|Client ID/u }),
    ).toHaveCount(0)

    unavailable = true
    await expect(
      page
        .getByRole('region', { name: 'Notifications', exact: true })
        .getByRole('alert')
        .filter({ hasText: /Connection settings|Could not connect|Client ID/u }),
    ).toHaveText('Connection settings are unavailable.')
    expect(injectedFailures).toBeGreaterThan(0)
    unavailable = false
    await expect(
      page
        .getByRole('region', { name: 'Notifications', exact: true })
        .getByRole('alert')
        .filter({ hasText: /Connection settings|Could not connect|Client ID/u }),
    ).toHaveCount(0, { timeout: 10_000 })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Apply and connect' })).toBeDisabled()
    expect(writes).toEqual([])
    await page.unrouteAll({ behavior: 'wait' })
  })
})
