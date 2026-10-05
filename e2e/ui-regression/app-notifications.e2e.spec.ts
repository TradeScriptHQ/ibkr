import type { ConnectionSnapshot } from '@ibkr-terminal/contracts'
import { expect, type Page, test } from '@playwright/test'

// App-only fault injection: every API request is intercepted, including all writes.
// These cases do not allocate an SDK workstation or contact IBKR.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

async function appFixture(page: Page) {
  const profile = {
    connectionType: 'ib-gateway' as const,
    port: 4002,
    clientId: 71,
    allowedAccountIds: [],
    agentTradingEnabled: false,
  }
  const connection: ConnectionSnapshot = {
    generation: 'notification-fixture',
    agentTradingRevision: 0,
    settings: { active: 'paper', profiles: { paper: profile, live: { ...profile, port: 4001 } } },
  }
  const state = {
    pollUnavailable: false,
    setupUnavailable: false,
    authorizationRejected: false,
    connectionTestSucceeds: false,
    pollFailures: 0,
    writes: [] as string[],
  }
  await page.route('**/api/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') state.writes.push(path)
    if (path === '/api/v1/session/bootstrap')
      return route.fulfill({
        json: {
          csrfToken: 'synthetic-notification-token-at-least-32-characters',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })
    if (path === '/api/v1/setup')
      return route.fulfill({
        status: state.setupUnavailable ? 502 : 200,
        json: state.setupUnavailable
          ? { error: { message: 'Setup is unavailable.' } }
          : {
              sdk: state.authorizationRejected
                ? {
                    configured: true,
                    ready: false,
                    state: 'error',
                    failure: 'rejected',
                    failureReason: 'unauthorized',
                    message: 'Saved SDK credentials need updating.',
                    version: '0.1.34',
                  }
                : { configured: true, ready: true, state: 'ready', version: '0.1.34' },
              connectionConfigured: true,
            },
      })
    if (path === '/api/v1/setup/sdk')
      return route.fulfill({
        status: 409,
        json: { error: { message: 'Could not clear the saved credentials.' } },
      })
    if (path === '/api/v1/connection' && request.method() === 'GET') {
      if (state.pollUnavailable) {
        state.pollFailures += 1
        return route.fulfill({ status: 502, body: 'Synthetic settings outage' })
      }
      return route.fulfill({ json: connection })
    }
    if (path === '/api/v1/connection/test')
      return route.fulfill({
        status: state.connectionTestSucceeds ? 200 : 502,
        json: state.connectionTestSucceeds
          ? { testId: 'synthetic-proof', accounts: ['DU-FIXTURE'] }
          : { error: { message: 'Could not connect to IB Gateway.' } },
      })
    if (path === '/api/v1/connection/retry')
      return route.fulfill({
        status: 502,
        json: { error: { message: 'The connection could not be retried.' } },
      })
    if (path === '/api/v1/status')
      return route.fulfill({
        status: 503,
        body: 'Synthetic workstation startup is blocked before SDK allocation.',
      })
    if (path === '/api/v1/ibkr/health')
      return route.fulfill({
        json: {
          ok: true,
          mode: 'paper',
          connectionType: 'ib-gateway',
          ibkrHost: '127.0.0.1',
          ibkrPort: 4002,
          backendPort: 3001,
          connectionStatus: 'connected',
        },
      })
    return route.abort('blockedbyclient')
  })
  return state
}

async function expectBottomRight(page: Page) {
  const stack = page.getByRole('region', { name: 'Notifications', exact: true })
  await expect(stack).toBeVisible()
  const geometry = await stack.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      right: window.innerWidth - bounds.right,
      bottom: window.innerHeight - bounds.bottom,
      left: bounds.left,
      top: bounds.top,
      position: style.position,
      rootPortal: element.parentElement === document.body,
    }
  })
  expect(geometry).toMatchObject({ position: 'fixed', rootPortal: true, right: 16, bottom: 16 })
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.top).toBeGreaterThanOrEqual(0)
}

test('poll errors share the bottom-right stack, dismiss quietly and clear on recovery', async ({
  page,
}) => {
  const state = await appFixture(page)
  state.pollUnavailable = true
  await page.goto('/')
  const stack = page.getByRole('region', { name: 'Notifications', exact: true })
  await expect(stack.getByRole('alert')).toHaveCount(2)
  await expect(stack).toContainText('Agent trading settings are unavailable.')
  await expect(stack).toContainText('Connection settings are unavailable.')
  await expect.poll(() => state.pollFailures).toBeGreaterThanOrEqual(6)
  await expect(stack.getByRole('alert')).toHaveCount(2)
  for (const width of [1728, 900, 400, 320]) {
    await page.setViewportSize({ width, height: 850 })
    await expectBottomRight(page)
  }
  await page.setViewportSize({ width: 900, height: 650 })
  await page.getByRole('button', { name: 'Connection', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Connection', exact: true })).toBeVisible()
  await expectBottomRight(page)
  await stack
    .locator('.app-notification')
    .filter({ hasText: 'Agent trading settings are unavailable.' })
    .getByRole('button', { name: 'Dismiss notification', exact: true })
    .click()
  await expect(stack.getByRole('alert')).toHaveCount(1)
  const failures = state.pollFailures
  await expect.poll(() => state.pollFailures).toBeGreaterThan(failures + 2)
  await expect(stack.getByRole('alert')).toHaveCount(1)
  await page
    .getByRole('dialog', { name: 'Connection', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .last()
    .click()
  state.pollUnavailable = false
  await expect(stack.getByRole('alert')).toHaveCount(0)
  // A dismissed alert being absent does not prove its producer has recovered.
  await expect(page.getByRole('button', { name: 'Setup agent', exact: true })).toBeEnabled()
  state.pollUnavailable = true
  await expect(stack.getByRole('alert')).toHaveCount(2)
  await page.screenshot({
    path: test.info().outputPath('app-notification-bottom-right.png'),
    clip: { x: 440, y: 490, width: 460, height: 160 },
  })
  expect(state.writes.every((path) => path === '/api/v1/session/bootstrap')).toBe(true)
})

test('connection errors and success appear over the open dialog and remain after closing it', async ({
  page,
}) => {
  const state = await appFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connection', exact: true })
  const stack = page.getByRole('region', { name: 'Notifications', exact: true })
  await expect(dialog.getByRole('button', { name: 'Test connection', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(stack.getByRole('alert')).toHaveText('Could not connect to IB Gateway.')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expectBottomRight(page)
  await stack.getByRole('button', { name: 'Dismiss notification', exact: true }).click()
  await expect(stack).toBeHidden()
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(stack.getByRole('alert')).toHaveText('Could not connect to IB Gateway.')
  state.connectionTestSucceeds = true
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(stack.getByRole('status')).toHaveText('Connection successful.')
  await expect(stack.getByRole('alert')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(stack.getByRole('status')).toHaveText('Connection successful.')
  await stack.getByRole('button', { name: 'Dismiss notification', exact: true }).click()
  await expect(stack).toBeHidden()
  expect(
    state.writes.every((path) =>
      ['/api/v1/session/bootstrap', '/api/v1/connection/test'].includes(path),
    ),
  ).toBe(true)
})

test('setup operation and polling errors and workstation retry failures use the same viewport', async ({
  page,
}) => {
  const state = await appFixture(page)
  await page.goto('/')
  const stack = page.getByRole('region', { name: 'Notifications', exact: true })
  await page.getByRole('button', { name: 'SDK settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Application settings', exact: true })
  await dialog.getByRole('button', { name: 'Clear credentials', exact: true }).click()
  await expect(stack.getByRole('alert')).toHaveText('Could not clear the saved credentials.')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expectBottomRight(page)
  await dialog.getByRole('button', { name: 'Close application settings', exact: true }).click()
  await expect(stack.getByRole('alert')).toHaveCount(0)
  state.setupUnavailable = true
  await expect(stack.getByRole('alert')).toHaveText(
    'Could not load application setup. Check that the local gateway is running.',
  )
  await expectBottomRight(page)
  state.setupUnavailable = false
  await expect(stack.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry workstation', exact: true }).click()
  await expect(stack.getByRole('alert')).toHaveText('The connection could not be retried.')
  await expectBottomRight(page)
  expect(
    state.writes.every((path) =>
      ['/api/v1/session/bootstrap', '/api/v1/setup/sdk', '/api/v1/connection/retry'].includes(path),
    ),
  ).toBe(true)
})

async function desktopUpdaterFixture(page: Page, development: boolean) {
  const invocations: string[] = []
  await page.exposeFunction('__notificationUpdateCommand', (command: string) => {
    invocations.push(command)
    throw new Error('Synthetic update check failure')
  })
  await page.route('**/__notification-update-fixture.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export const isTauri = () => true; export const invoke = (command) => window.__notificationUpdateCommand(command);`,
    }),
  )
  await page.route('**/src/desktop-updates.tsx*', async (route) => {
    const response = await route.fetch()
    let source = await response.text()
    const importPattern = /from\s*['"][^'"]*@tauri-apps_api_core[^'"]*['"]/u
    expect(source).toMatch(importPattern)
    expect(source).toContain('import.meta.env.DEV')
    // Model the release environment for this component without enabling native commands.
    if (!development) source = source.replaceAll('import.meta.env.DEV', 'false')
    await route.fulfill({
      response,
      body: source.replace(importPattern, 'from "/__notification-update-fixture.js"'),
    })
  })
  return invocations
}

test('development desktop hides updates and never calls the native updater', async ({ page }) => {
  await appFixture(page)
  const invocations = await desktopUpdaterFixture(page, true)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'SDK settings', exact: true })).toBeVisible()
  await expect(page.getByLabel('Updates', { exact: true })).toHaveCount(0)
  await expect(page.locator('.desktop-updates')).toHaveCount(0)
  await expect(page.getByText('Could not check for updates. Try again later.')).toHaveCount(0)
  expect(invocations).toEqual([])
})

test('release desktop update feedback uses the viewport instead of the update popover', async ({
  page,
}) => {
  await appFixture(page)
  const invocations = await desktopUpdaterFixture(page, false)
  await page.goto('/')
  const stack = page.getByRole('region', { name: 'Notifications', exact: true })
  await expect(stack.getByRole('alert')).toHaveText('Could not check for updates. Try again later.')
  await page.getByLabel('Updates', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Check for updates', exact: true })).toBeVisible()
  await expect(
    page.locator('.desktop-update-panel [role="status"], .desktop-update-panel [role="alert"]'),
  ).toHaveCount(0)
  await expectBottomRight(page)
  const startupChecks = invocations.length
  expect(startupChecks).toBeGreaterThan(0)
  expect(invocations.every((command) => command === 'check_update')).toBe(true)
  // Startup is deliberately blocked in this app-only fixture; its overlay covers
  // the popover. Exercise the manual action through the button's keyboard activation.
  await page.getByRole('button', { name: 'Check for updates', exact: true }).press('Enter')
  await expect.poll(() => invocations.length).toBe(startupChecks + 1)
  await expect(stack.getByRole('alert')).toHaveText('Could not check for updates. Try again later.')
})

test('authorization recovery feedback uses the viewport on the setup screen', async ({ page }) => {
  const state = await appFixture(page)
  state.authorizationRejected = true
  await page.goto('/')
  const setup = page.getByRole('region', { name: 'Workstation setup', exact: true })
  await expect(setup.getByText('Restore SDK access', { exact: true })).toBeVisible()
  await expect(setup.getByLabel('Client key', { exact: true })).toBeVisible()
  const stack = page.getByRole('region', { name: 'Notifications', exact: true })
  await expect(stack).toContainText('SDK credentials need updating')
  await expect(stack).toContainText('Saved SDK credentials need updating.')
  await expect(setup.getByRole('alert')).toHaveCount(0)
  await expect(
    stack.getByRole('button', { name: 'Retry authorization', exact: true }),
  ).toBeEnabled()
  await expectBottomRight(page)
  expect(state.writes.every((path) => path === '/api/v1/session/bootstrap')).toBe(true)
})

test('About document failures appear above its dialog in the shared viewport', async ({ page }) => {
  await appFixture(page)
  await page.route('**/__notification-native-fixture.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export const isTauri = () => true;
export const getVersion = async () => '0.1.0';
export const getCurrentWindow = () => ({ minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {} });`,
    }),
  )
  for (const component of ['desktop-chrome', 'legal-notices']) {
    await page.route(`**/src/${component}.tsx*`, async (route) => {
      const response = await route.fetch()
      const source = await response.text()
      await route.fulfill({
        response,
        body: source.replace(
          /from\s*['"][^'"]*@tauri-apps_api_(?:core|app|window)[^'"]*['"]/gu,
          'from "/__notification-native-fixture.js"',
        ),
      })
    })
  }
  await page.route('**/legal/*', (route) =>
    route.fulfill({ status: 404, body: 'Synthetic missing document' }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'SDK settings', exact: true }).waitFor()
  await page.evaluate(() => window.dispatchEvent(new Event('terminal:about')))
  const about = page.getByRole('dialog')
  await about.getByRole('button', { name: 'Software licences', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Notifications', exact: true }).getByRole('alert'),
  ).toHaveText('This document is unavailable in this build.')
  await expectBottomRight(page)
  await about.getByRole('button', { name: 'Back to About', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toBeHidden()
})
