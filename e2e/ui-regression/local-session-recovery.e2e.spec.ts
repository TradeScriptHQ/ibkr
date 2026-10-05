import type { ConnectionSnapshot } from '@ibkr-terminal/contracts'
import { expect, type Page, test } from '@playwright/test'

// These are synthetic local-session responses. All API requests are intercepted,
// broker requests are aborted, and no credentials or broker policy are changed.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const ORIGINAL_CSRF = 'synthetic-original-csrf-token-at-least-32-characters'
const RECOVERED_CSRF = 'synthetic-recovered-csrf-token-at-least-32-characters'
const INVALID_SESSION = {
  error: { code: 'invalid-session', message: 'Synthetic local session is no longer valid.' },
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function interceptLocalSession(page: Page) {
  const profile = {
    connectionType: 'tws' as const,
    port: 7497,
    clientId: 71,
    allowedAccountIds: [],
    agentTradingEnabled: false,
  }
  const connection: ConnectionSnapshot = {
    generation: 'synthetic-local-session-connection',
    agentTradingRevision: 0,
    settings: {
      active: 'paper',
      profiles: { paper: profile, live: { ...profile, port: 7496 } },
    },
  }
  const state = {
    expired: false,
    recovered: false,
    bootstrapFailures: 0,
    recoveryGate: undefined as Promise<void> | undefined,
    mutationExpiresSession: false,
    bootstraps: 0,
    recoveryBootstraps: 0,
    setupSuccesses: 0,
    setupFailures: 0,
    workstationStarts: 0,
    events: [] as string[],
    credentialWrites: [] as { method: string; csrf: string | undefined }[],
    blockedWrites: [] as string[],
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path.startsWith('/api/v1/ibkr/')) {
      if (method !== 'GET') state.blockedWrites.push(`${method} ${path}`)
      return route.abort('blockedbyclient')
    }
    if (path === '/api/v1/session/bootstrap' && method === 'POST') {
      state.bootstraps += 1
      if (state.expired) {
        state.recoveryBootstraps += 1
        if (state.bootstrapFailures > 0) {
          state.bootstrapFailures -= 1
          state.events.push('bootstrap:502')
          return route.fulfill({
            status: 502,
            json: { error: { message: 'Synthetic gateway restart is still in progress.' } },
          })
        }
        await state.recoveryGate
        state.expired = false
        state.recovered = true
      }
      // Resuming this session always returns the same token until the simulated reset.
      // A token per request would represent another authority change, not a resumed session.
      state.events.push(`bootstrap:${state.recovered ? 'recovered' : 'original'}`)
      return route.fulfill({
        json: {
          csrfToken: state.recovered ? RECOVERED_CSRF : ORIGINAL_CSRF,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })
    }
    if (path === '/api/v1/setup' && method === 'GET') {
      if (state.expired) {
        state.setupFailures += 1
        state.events.push('setup:401')
        return route.fulfill({ status: 401, json: INVALID_SESSION })
      }
      state.setupSuccesses += 1
      state.events.push(`setup:${state.recovered ? 'recovered' : 'original'}`)
      return route.fulfill({
        json: {
          sdk: { configured: true, ready: true, state: 'ready', version: '0.1.34' },
          connectionConfigured: true,
        },
      })
    }
    if (path === '/api/v1/connection' && method === 'GET')
      return route.fulfill({ json: connection })
    if (path === '/api/v1/status' && method === 'GET') {
      state.workstationStarts += 1
      // Stop before SDK allocation. Rendering the toolbar and setup recovery needs no lease.
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic workstation startup is deliberately blocked.' } },
      })
    }
    if (path === '/api/v1/tradescript/bootstrap' && method === 'GET')
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic SDK allocation is deliberately blocked.' } },
      })
    if (path === '/api/v1/setup/sdk' && method === 'DELETE') {
      state.credentialWrites.push({
        method,
        csrf: request.headers()['x-tradescript-csrf'],
      })
      if (state.mutationExpiresSession) {
        state.mutationExpiresSession = false
        state.expired = true
        return route.fulfill({ status: 401, json: INVALID_SESSION })
      }
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic credential changes are deliberately blocked.' } },
      })
    }
    if (method !== 'GET') {
      state.blockedWrites.push(`${method} ${path}`)
      return route.abort('blockedbyclient')
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected synthetic API request.' } },
    })
  })
  await page.route('**/mcp-local/**', (route) => route.abort('blockedbyclient'))
  return state
}

async function readyWorkstation(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'SDK settings', exact: true })).toBeVisible()
  await expect(page.getByText('Gateway readiness is unavailable.', { exact: true })).toBeVisible()
  // A document marker proves recovery uses the existing page rather than a reload.
  await page.locator('html').evaluate((element) => {
    element.setAttribute('data-session-recovery-document', 'original-document')
  })
}

async function expectRecovered(page: Page) {
  await expect(page.getByText('Reconnecting to local gateway', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Your local session expired', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reload workstation', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'SDK settings', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute(
    'data-session-recovery-document',
    'original-document',
  )
}

test.afterEach(async ({ page }) => {
  // Keep interception in place until component polling and pending requests have stopped.
  await page.close()
})

test('a ready workstation renews an invalid local session and clears its notice without a reload', async ({
  page,
}) => {
  test.info().annotations.push({
    type: 'qualification',
    description: 'Synthetic session recovery only; SDK allocation and broker access are blocked.',
  })
  const fixture = await interceptLocalSession(page)
  const recovery = deferred()
  fixture.recoveryGate = recovery.promise
  try {
    await readyWorkstation(page)
    const startsBeforeReset = fixture.workstationStarts
    fixture.expired = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => fixture.setupFailures).toBe(1)
    await expect(page.getByText('Reconnecting to local gateway', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'SDK settings', exact: true })).toBeVisible()
    recovery.release()

    await expect.poll(() => fixture.events.includes('setup:recovered')).toBe(true)
    await expect.poll(() => fixture.workstationStarts).toBeGreaterThan(startsBeforeReset)
    await expectRecovered(page)
    const rejectedRead = fixture.events.indexOf('setup:401')
    const renewedSession = fixture.events.indexOf('bootstrap:recovered')
    const recoveredRead = fixture.events.indexOf('setup:recovered')
    expect(rejectedRead).toBeLessThan(renewedSession)
    expect(renewedSession).toBeLessThan(recoveredRead)

    await page.getByRole('button', { name: 'SDK settings', exact: true }).click()
    await page.getByRole('button', { name: 'Clear credentials', exact: true }).click()
    await expect.poll(() => fixture.credentialWrites.length).toBe(1)
    expect(fixture.credentialWrites).toEqual([{ method: 'DELETE', csrf: RECOVERED_CSRF }])
    expect(fixture.blockedWrites).toEqual([])
  } finally {
    recovery.release()
  }
})

test('a temporary bootstrap failure retries automatically and leaves no expired-session banner', async ({
  page,
}) => {
  const fixture = await interceptLocalSession(page)
  const recovery = deferred()
  fixture.recoveryGate = recovery.promise
  try {
    await readyWorkstation(page)
    fixture.bootstrapFailures = 1
    fixture.expired = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => fixture.events.includes('bootstrap:502')).toBe(true)
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'SDK settings', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reload workstation', exact: true })).toHaveCount(
      0,
    )
    recovery.release()

    // No click or reload: normal polling must recover when the gateway becomes available.
    await expect.poll(() => fixture.events.includes('setup:recovered')).toBe(true)
    expect(fixture.recoveryBootstraps).toBeGreaterThanOrEqual(2)
    await expectRecovered(page)
    expect(fixture.credentialWrites).toEqual([])
    expect(fixture.blockedWrites).toEqual([])
  } finally {
    recovery.release()
  }
})

test('session recovery never replays a rejected credential mutation', async ({ page }) => {
  const fixture = await interceptLocalSession(page)
  await readyWorkstation(page)
  fixture.mutationExpiresSession = true
  await page.getByRole('button', { name: 'SDK settings', exact: true }).click()
  await page.getByRole('button', { name: 'Clear credentials', exact: true }).click()
  await expect.poll(() => fixture.events.includes('setup:recovered')).toBe(true)
  await expectRecovered(page)
  expect(fixture.credentialWrites).toEqual([{ method: 'DELETE', csrf: ORIGINAL_CSRF }])

  const successfulReads = fixture.setupSuccesses
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => fixture.setupSuccesses).toBeGreaterThan(successfulReads)
  expect(fixture.credentialWrites).toHaveLength(1)
  expect(fixture.blockedWrites).toEqual([])
})
