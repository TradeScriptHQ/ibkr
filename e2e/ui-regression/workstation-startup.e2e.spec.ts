import { expect, type Page, test } from '@playwright/test'
import type { SetupStatus } from '../../apps/terminal/src/sdk-authorization.js'

// All API responses are synthetic. Startup stops before SDK allocation and no
// broker requests, credential changes, or financial writes reach the gateway.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

async function interceptStartup(page: Page) {
  const setupGate = Promise.withResolvers<void>()
  const authorizationGate = Promise.withResolvers<void>()
  const setup: SetupStatus = {
    sdk: { configured: true, ready: true, state: 'ready' },
    connectionConfigured: true,
  }
  const state = {
    setupGate,
    authorizationGate,
    setupRequests: 0,
    workstationRequests: 0,
    setupHttpStatus: 200,
    setup,
    blockedWrites: [] as string[],
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (pathname === '/api/v1/session/bootstrap' && request.method() === 'POST')
      return route.fulfill({
        json: {
          csrfToken: 'synthetic-startup-csrf-token-at-least-32-characters',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })
    if (request.method() !== 'GET') {
      state.blockedWrites.push(`${request.method()} ${pathname}`)
      return route.abort('blockedbyclient')
    }
    if (pathname === '/api/v1/setup') {
      state.setupRequests += 1
      await setupGate.promise
      return route.fulfill({
        status: state.setupHttpStatus,
        json: state.setupHttpStatus === 200 ? state.setup : { error: { message: 'Unavailable' } },
      })
    }
    if (pathname === '/api/v1/tradescript/bootstrap') {
      state.workstationRequests += 1
      await authorizationGate.promise
      return route.fulfill({ status: 503, json: { error: { message: 'Synthetic SDK stop' } } })
    }
    return route.fulfill({ status: 503, json: { error: { message: 'Synthetic startup stop' } } })
  })
  await page.route('**/mcp-local/**', (route) => route.abort('blockedbyclient'))
  return state
}

test.afterEach(async ({ page }) => {
  await page.close()
})

test('one mounted loading screen advances from saved setup to authorization without onboarding', async ({
  page,
}) => {
  const fixture = await interceptStartup(page)
  try {
    await page.goto('/')
    const screen = page.locator('.terminal-overlay')
    await expect(screen).toHaveCount(1)
    await expect(screen.getByText('Checking saved setup…', { exact: true })).toBeVisible()
    await expect(screen.getByText('Step 1 of 8', { exact: true })).toBeVisible()
    await expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0')
    await page.locator('.terminal-frame').screenshot({
      path: test.info().outputPath('checking-saved-setup.png'),
    })
    await expect(page.locator('.setup-page')).toHaveCount(0)
    await expect.poll(() => fixture.setupRequests).toBe(1)
    expect(fixture.workstationRequests).toBe(0)
    const originalScreen = await screen.elementHandle()
    if (!originalScreen) throw new Error('The initial loading screen did not mount')

    fixture.setupGate.resolve()
    // The live StrictMode pass must consume the original response, without the
    // old five-second delay caused by discarding it and waiting for another poll.
    await expect(screen.getByText('Authorizing workstation…', { exact: true })).toBeVisible({
      timeout: 2_000,
    })
    await expect(screen.getByText('Step 2 of 8', { exact: true })).toBeVisible()
    await expect(screen).toHaveCount(1)
    expect(await originalScreen.evaluate((element) => element.isConnected)).toBe(true)
    expect(fixture.setupRequests).toBe(1)
    await expect.poll(() => fixture.workstationRequests).toBe(1)
    await expect(page.locator('.setup-page')).toHaveCount(0)
    expect(fixture.blockedWrites).toEqual([])
  } finally {
    fixture.setupGate.resolve()
    fixture.authorizationGate.resolve()
  }
})

test('onboarding appears only after saved setup is confirmed missing', async ({ page }) => {
  const fixture = await interceptStartup(page)
  fixture.setup = { sdk: { configured: false, ready: false }, connectionConfigured: false }
  try {
    await page.goto('/')
    await expect(page.getByText('Checking saved setup…', { exact: true })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Activate SDK' })).toHaveCount(0)
    fixture.setupGate.resolve()
    await expect(page.getByRole('form', { name: 'Activate SDK' })).toBeVisible()
    await expect(page.locator('.terminal-overlay')).toHaveCount(0)
    expect(fixture.workstationRequests).toBe(0)
    expect(fixture.blockedWrites).toEqual([])
  } finally {
    fixture.setupGate.resolve()
    fixture.authorizationGate.resolve()
  }
})

test('an unavailable setup read stays on the same screen and retries only setup', async ({
  page,
}) => {
  const fixture = await interceptStartup(page)
  fixture.setupHttpStatus = 503
  try {
    await page.goto('/')
    const screen = page.locator('.terminal-overlay')
    await expect(screen.getByText('Checking saved setup…', { exact: true })).toBeVisible()
    const originalScreen = await screen.elementHandle()
    if (!originalScreen) throw new Error('The initial loading screen did not mount')
    fixture.setupGate.resolve()
    await expect(screen.getByRole('button', { name: 'Retry setup', exact: true })).toBeVisible()
    await expect(page.locator('.setup-page')).toHaveCount(0)
    fixture.setupHttpStatus = 200
    await screen.getByRole('button', { name: 'Retry setup', exact: true }).click()
    await expect(screen.getByText('Authorizing workstation…', { exact: true })).toBeVisible()
    expect(await originalScreen.evaluate((element) => element.isConnected)).toBe(true)
    expect(fixture.setupRequests).toBe(2)
    expect(fixture.blockedWrites).toEqual([])
  } finally {
    fixture.setupGate.resolve()
    fixture.authorizationGate.resolve()
  }
})

test('a saved setup awaiting SDK authorization keeps the loading screen mounted', async ({
  page,
}) => {
  const fixture = await interceptStartup(page)
  fixture.setup.sdk = { configured: true, ready: false, state: 'exchanging' }
  try {
    await page.goto('/')
    const screen = page.locator('.terminal-overlay')
    await expect(screen.getByText('Checking saved setup…', { exact: true })).toBeVisible()
    const originalScreen = await screen.elementHandle()
    if (!originalScreen) throw new Error('The initial loading screen did not mount')
    fixture.setupGate.resolve()
    await expect(screen.getByText('Authorizing workstation…', { exact: true })).toBeVisible()
    await expect(screen.getByText('Step 2 of 8', { exact: true })).toBeVisible()
    expect(fixture.workstationRequests).toBe(0)
    await expect(page.locator('.setup-page')).toHaveCount(0)
    fixture.setup.sdk = { configured: true, ready: true, state: 'ready' }
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => fixture.workstationRequests).toBe(1)
    expect(await originalScreen.evaluate((element) => element.isConnected)).toBe(true)
    expect(fixture.blockedWrites).toEqual([])
  } finally {
    fixture.setupGate.resolve()
    fixture.authorizationGate.resolve()
  }
})
