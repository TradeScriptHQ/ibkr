import { access } from 'node:fs/promises'
import path from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect, test } from '../support/fixtures.js'
import { openTerminalSession } from '../support/session.js'

async function usePackagedTerminal(page: Page) {
  const root = path.resolve('apps/terminal/dist')
  await access(path.join(root, 'index.html'))
  await page.route('http://localhost:3000/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (
      pathname !== '/' &&
      !pathname.startsWith('/assets/') &&
      !['/favicon.png', '/terminal-logo.png'].includes(pathname)
    )
      return route.fallback()
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Unexpected production asset path')
    await route.fulfill({ path: file })
  })
}

async function fetchBrowserLease(route: Route) {
  // route.fetch uses an API context, so retain the terminal's browser request proof.
  return route.fetch({
    headers: {
      ...(await route.request().allHeaders()),
      origin: new URL(route.request().url()).origin,
      'sec-fetch-site': 'same-origin',
      'x-tradescript-client': 'terminal-v1',
    },
  })
}

// Uses the real packaged SDK and the local gateway's valid startup token. Only the
// browser response is fault-injected; credentials and gateway authorization are untouched.
test('a transient browser renewal outage keeps the workstation mounted and recovers', async ({
  page,
}) => {
  await usePackagedTerminal(page)
  let requests = 0
  let mounted = false
  await page.route('**/api/v1/tradescript/bootstrap', async (route) => {
    if (mounted) requests += 1
    if (mounted && requests === 1)
      return route.fulfill({ status: 502, body: 'Temporary local proxy outage' })
    const response = await fetchBrowserLease(route)
    expect(
      response.status(),
      'The real startup lease must be available before renewal injection',
    ).toBe(200)
    const bootstrap = await response.json()
    await route.fulfill({
      response,
      json: {
        ...bootstrap,
        renewAfter: new Date(Date.now() + 100).toISOString(),
      },
    })
  })
  await page.goto('/')
  const terminal = page.getByRole('region', { name: 'IBKR Chart', exact: true })
  await expect(terminal).toBeVisible()
  mounted = true
  await expect.poll(() => requests).toBeGreaterThanOrEqual(2)
  await expect(terminal).toBeVisible()
  await expect(page.getByText('Workstation unavailable', { exact: true })).toHaveCount(0)
  // Finish intercepted requests before the fixture closes its API response context.
  await page.unrouteAll({ behavior: 'wait' })
})

test('the mounted SDK verifies a replacement lease and exposes failure with retry', async ({
  page,
}) => {
  await usePackagedTerminal(page)
  let mounted = false
  await page.route('**/api/v1/tradescript/bootstrap', async (route) => {
    const response = await fetchBrowserLease(route)
    expect(
      response.status(),
      'The real startup lease must be available before renewal injection',
    ).toBe(200)
    const startup = await response.json()
    return route.fulfill({
      response,
      json: {
        ...startup,
        renewAfter: new Date(Date.now() + 100).toISOString(),
        ...(mounted ? { lease: 'invalid-replacement-token'.repeat(4) } : {}),
      },
    })
  })
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'IBKR Chart', exact: true })).toBeVisible()
  mounted = true
  await expect(page.getByText('Workstation unavailable', { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      'TradeScript browser authorization could not be renewed. Retry the workstation or restore SDK access.',
      { exact: true },
    ),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry workstation', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'IBKR Chart', exact: true })).toHaveCount(0)
})

test('the mounted packaged SDK accepts a different valid server-signed lease without unmounting', async ({
  page,
  request,
}) => {
  await usePackagedTerminal(page)
  let initialLease: string | undefined
  let differentLeaseDelivered = false
  let pollsAfterReplacement = 0
  await page.route('**/api/v1/tradescript/bootstrap', async (route) => {
    // Only this browser's scheduled bootstrap polls enter the route. A new poll
    // after delivery means followSdkLease completed its awaited replaceLease.
    if (differentLeaseDelivered) pollsAfterReplacement += 1
    const response = await fetchBrowserLease(route)
    expect(response.status(), 'The real server-signed lease must remain available').toBe(200)
    const bootstrap = await response.json()
    expect(typeof bootstrap.lease === 'string', 'Bootstrap must contain a signed lease').toBe(true)
    initialLease ??= bootstrap.lease
    const different = bootstrap.lease !== initialLease
    await route.fulfill({
      response,
      json: { ...bootstrap, renewAfter: new Date(Date.now() + 100).toISOString() },
    })
    if (different) differentLeaseDelivered = true
  })

  try {
    await page.goto('/')
    const terminal = page.getByRole('region', { name: 'IBKR Chart', exact: true })
    await expect(terminal).toBeVisible()
    await expect(page.getByRole('button', { name: 'Chart data', exact: true })).toBeEnabled()
    const chartElement = await terminal.elementHandle()
    const mountElement = await page.locator('.terminal-host > div').elementHandle()
    expect(Boolean(chartElement && mountElement), 'The original packaged mount must exist').toBe(
      true,
    )
    expect(initialLease !== undefined, 'The mounted SDK must have received its startup lease').toBe(
      true,
    )

    const session = await openTerminalSession(request)
    const retry = await request.post('/api/v1/setup/sdk/retry', {
      headers: session.mutationHeaders,
      data: {},
    })
    expect(
      retry.status(),
      'Existing SDK credentials must obtain a refreshed server-signed lease',
    ).toBe(200)
    expect((await retry.json()).ready === true).toBe(true)

    // Token values remain private: only the different-token comparison is asserted.
    await expect
      .poll(() => differentLeaseDelivered, {
        message:
          'The authorization server must rotate the lease rather than return the startup token',
      })
      .toBe(true)
    await expect
      .poll(() => pollsAfterReplacement, {
        message: 'A subsequent browser poll must follow successful SDK lease replacement',
      })
      .toBeGreaterThanOrEqual(1)
    expect(await mountElement?.evaluate((element) => element.isConnected)).toBe(true)
    expect(await chartElement?.evaluate((element) => element.isConnected)).toBe(true)
    await expect(terminal).toBeVisible()
    await expect(page.getByRole('button', { name: 'Chart data', exact: true })).toBeEnabled()
    await expect(page.getByText('Workstation unavailable', { exact: true })).toHaveCount(0)
  } finally {
    await page.unrouteAll({ behavior: 'wait' })
  }
})
