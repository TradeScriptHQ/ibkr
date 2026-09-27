import { expect, test } from '../support/fixtures.js'

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
  await expect(dialog.getByText('Connection successful')).toBeVisible()
  await expect(dialog.getByText('Accounts from TWS: DU-example')).toBeVisible()
  await expect(apply).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('connection-discovered.png') })
  await dialog.getByText('Advanced settings', { exact: true }).click()
  await expect(dialog.getByRole('spinbutton', { name: 'Client ID', exact: true })).toBeVisible()
  await dialog.getByRole('spinbutton', { name: 'Port', exact: true }).fill('4002')
  await expect(apply).toBeDisabled()
  succeeds = false
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Could not connect to TWS.')
  await expect(apply).toBeDisabled()
  await dialog.getByText('Advanced settings', { exact: true }).click()
  failureMessage = 'Client ID is already in use.'
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(dialog.getByRole('spinbutton', { name: 'Client ID', exact: true })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveText(failureMessage)
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
    ['gateway', 'Gateway offline'],
    ['healthy', 'TWS connected'],
  ] as const) {
    phase = next
    await expect(status).toHaveText(label, { timeout: 10_000 })
    if (next === 'data')
      await page.screenshot({ path: test.info().outputPath('header-market-data-offline.png') })
  }
})
