import { expect, test } from '@playwright/test'

// These responses exercise rendering and recovery only; no broker or production
// authorization requests are made by this browser.
for (const [reason, title, status, replacesCredentials] of [
  ['trial_access_expired', 'Free trial access has ended', 403, false],
  ['subscription_access_expired', 'Subscription access has ended', 403, false],
  ['subscription_inactive', 'Subscription needs attention', 403, false],
  ['account_closed', 'Account is closed', 403, false],
  ['client_suspended', 'SDK access is suspended', 403, false],
  ['sdk_version_not_authorized', 'SDK version is not authorized', 403, false],
  ['sdk_build_not_authorized', 'SDK build is not authorized', 403, false],
  ['origin_not_authorized', 'Browser origin is not authorized', 403, false],
  ['deployment_not_authorized', 'Application is not authorized', 403, false],
  ['unauthorized', 'SDK credentials need updating', 401, true],
  ['authorization_changed', 'SDK authorization changed', 409, false],
  ['authorization_unavailable', 'SDK authorization temporarily unavailable', 503, false],
  ['internal_error', 'SDK authorization service error', 500, false],
  ['invalid_request', 'SDK authorization request needs correcting', 400, false],
  ['not_found', 'SDK authorization endpoint was not found', 404, false],
  ['method_not_allowed', 'SDK authorization method is not supported', 405, false],
] as const) {
  test(`explains ${reason} with the corresponding recovery action`, async ({ page }) => {
    let retries = 0
    const message = `Detailed authorization reason for ${reason}. Resolve this issue, then retry with the saved identity.`
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/v1/session/bootstrap')
        return route.fulfill({
          json: {
            csrfToken: 'fixture-csrf-token-with-at-least-32-characters',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        })
      if (path === '/api/v1/setup')
        return route.fulfill({
          json: {
            sdk: {
              configured: true,
              ready: false,
              state: 'error',
              failure: status >= 500 || status === 409 ? 'unavailable' : 'rejected',
              failureReason: reason,
              message,
              version: '0.1.34',
            },
            connectionConfigured: true,
          },
        })
      if (path === '/api/v1/setup/sdk/retry') {
        retries++
        return route.fulfill({
          status,
          json: { error: { message, code: reason, source: 'tradescript-authorization' } },
        })
      }
      return route.fulfill({
        status: 404,
        json: { error: { message: 'Unexpected fixture request' } },
      })
    })
    await page.goto('/')
    await expect(page.getByText(title, { exact: true })).toBeVisible()
    await expect(page.getByText(message, { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Developer Console' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Buy license|Log in|Sync License/ })).toHaveCount(
      0,
    )
    if (replacesCredentials)
      await expect(page.getByLabel('Client key', { exact: true })).toBeVisible()
    else await expect(page.getByLabel('Client key', { exact: true })).toHaveCount(0)
    await expect(
      page.getByText('Your broker connection settings and saved workspace are preserved.'),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Retry authorization' }).click()
    await expect.poll(() => retries).toBe(1)
    await expect(page.getByRole('alert').filter({ hasText: message }).last()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reload workstation' })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath(`${reason}.png`) })
  })
}

for (const operation of ['activate', 'retry'] as const) {
  test(`shows a helpful message for a non-JSON ${operation} failure`, async ({ page }) => {
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/v1/session/bootstrap')
        return route.fulfill({
          json: {
            csrfToken: 'fixture-csrf-token-with-at-least-32-characters',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        })
      if (path === '/api/v1/setup')
        return route.fulfill({
          json: {
            sdk: {
              configured: operation === 'retry',
              ready: false,
              state: 'error',
              failure: 'rejected',
              version: '0.1.34',
            },
            connectionConfigured: false,
          },
        })
      if (path === '/api/v1/setup/sdk' || path === '/api/v1/setup/sdk/retry')
        return route.fulfill({
          status: 502,
          contentType: 'text/html',
          body: '<html>Local gateway unavailable</html>',
        })
      return route.fulfill({
        status: 404,
        json: { error: { message: 'Unexpected fixture request' } },
      })
    })
    await page.goto('/')
    if (operation === 'activate') {
      await page.getByLabel('Client key', { exact: true }).fill('synthetic-credential')
      await page.getByLabel('Secret', { exact: true }).fill('synthetic-secret')
      await page.getByRole('button', { name: 'Activate SDK', exact: true }).click()
    } else await page.getByRole('button', { name: 'Retry authorization', exact: true }).click()
    await expect(
      page.getByRole('alert').filter({
        hasText:
          operation === 'activate'
            ? 'Could not activate the SDK.'
            : 'Could not restore SDK access.',
      }),
    ).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/Unexpected token|not valid JSON/)).toHaveCount(0)
  })
}

for (const operation of ['activate', 'retry'] as const) {
  for (const status of [401, 204]) {
    test(`${operation} handles ${status === 401 ? 'HTML session expiry' : 'empty success'}`, async ({
      page,
    }) => {
      let mutations = 0
      let confirmedSetupReads = 0
      await page.route('**/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/v1/session/bootstrap')
          return route.fulfill({
            json: {
              csrfToken: 'fixture-csrf-token-with-at-least-32-characters',
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          })
        if (path === '/api/v1/setup') {
          if (mutations > 0) confirmedSetupReads += 1
          return route.fulfill({
            json: {
              sdk: {
                configured: operation === 'retry',
                ready: status === 204 && mutations > 0,
                state: status === 204 && mutations > 0 ? 'ready' : 'error',
                failure: 'rejected',
                version: '0.1.34',
              },
              connectionConfigured: false,
            },
          })
        }
        if (path === '/api/v1/setup/sdk' || path === '/api/v1/setup/sdk/retry') {
          mutations += 1
          return route.fulfill({
            status,
            ...(status === 401
              ? { contentType: 'text/html', body: '<html>Local session expired</html>' }
              : {}),
          })
        }
        return route.fulfill({
          status: 404,
          json: { error: { message: 'Unexpected fixture request' } },
        })
      })
      await page.goto('/')
      if (operation === 'activate') {
        await page.getByLabel('Client key', { exact: true }).fill('synthetic-credential')
        await page.getByLabel('Secret', { exact: true }).fill('synthetic-secret')
        await page.getByRole('button', { name: 'Activate SDK', exact: true }).click()
      } else await page.getByRole('button', { name: 'Retry authorization', exact: true }).click()
      await expect.poll(() => mutations).toBe(1)
      if (status === 401) {
        await expect(
          page
            .getByRole('region', { name: 'Notifications', exact: true })
            .getByRole('alert')
            .filter({
              hasText:
                operation === 'activate'
                  ? 'Could not activate the SDK.'
                  : 'Could not restore SDK access.',
            }),
        ).toBeVisible()
        // This fixture returns 200 for the next authenticated setup read. Check
        // the confirmed recovered state instead of racing a transient reload prompt.
        await expect.poll(() => confirmedSetupReads).toBeGreaterThan(0)
        await expect(
          page.getByRole('button', { name: 'Reload workstation', exact: true }),
        ).toHaveCount(0)
        expect(mutations).toBe(1)
      } else
        await expect(
          page.getByText('SDK credentials saved · Activated', { exact: true }),
        ).toBeVisible()
      await expect(
        page.getByText(/Unexpected token|not valid JSON|Unexpected end of JSON/),
      ).toHaveCount(0)
    })
  }
}

test('clears only local SDK access and returns to blank manual Client key and Secret setup', async ({
  page,
}) => {
  let cleared = false
  const requests: string[] = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    requests.push(path)
    if (path === '/api/v1/session/bootstrap')
      return route.fulfill({
        json: {
          csrfToken: 'fixture-csrf-token-with-at-least-32-characters',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      })
    if (path === '/api/v1/setup')
      return route.fulfill({
        json: {
          sdk: {
            configured: !cleared,
            ready: false,
            state: cleared ? 'unconfigured' : 'error',
            ...(cleared ? {} : { failure: 'unavailable' }),
            version: '0.1.34',
          },
          connectionConfigured: true,
        },
      })
    if (path === '/api/v1/setup/sdk') {
      expect(route.request().method()).toBe('DELETE')
      expect(route.request().headers()['x-tradescript-csrf']).toBeTruthy()
      cleared = true
      return route.fulfill({ json: { configured: false, ready: false } })
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected fixture request' } },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Clear credentials', exact: true }).click()
  await expect(page.getByLabel('Client key', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Secret', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Activate SDK', exact: true })).toBeDisabled()
  await expect(
    page.getByRole('button', { name: /Log in|Sync License|Buy license|Log out/ }),
  ).toHaveCount(0)
  expect(cleared).toBe(true)
  expect(requests.every((path) => !path.startsWith('/api/v1/setup/account/'))).toBe(true)
})
