import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { openTerminalSession } from './support/session.js'

const sourcePages = new WeakSet<Page>()
test.beforeEach(({ page }) => {
  page.on('response', (response) => {
    if (
      response.status() === 200 &&
      new URL(response.url()).pathname.endsWith('/src/sdk/sourceDevelopmentSdk.ts')
    )
      sourcePages.add(page)
  })
})
test.afterEach(async ({ page }) => {
  const sourceSdkLoaded = sourcePages.has(page)
  await test.info().attach('sdk-runtime-mode', {
    body: JSON.stringify({ sourceSdkLoaded }),
    contentType: 'application/json',
  })
  if (process.env.TERMINAL_E2E_SOURCE_MODE === '1') expect(sourceSdkLoaded).toBe(true)
})

async function openSettings(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'SDK settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Application settings', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

async function expectContained(page: Page, dialog: Locator, width: number) {
  await page.setViewportSize({ width, height: 850 })
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const content = element.querySelector('.setup-content')
        if (!(content instanceof HTMLElement)) return false
        return (
          rect.left >= -1 &&
          rect.right <= window.innerWidth + 1 &&
          content.scrollWidth <= content.clientWidth + 1 &&
          [...content.querySelectorAll('input,button')].every((control) => {
            const bounds = control.getBoundingClientRect()
            return bounds.left >= rect.left - 1 && bounds.right <= rect.right + 1
          })
        )
      }),
    )
    .toBe(true)
}

test('activated application settings show saved access without onboarding or blank credentials', async ({
  page,
  request,
}) => {
  await openTerminalSession(request)
  const dialog = await openSettings(page)
  await expect(dialog.getByText('SDK credentials saved · Activated', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Connection settings saved', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Chart data', exact: true })).toBeVisible()
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Chart data', exact: true }),
  ).toHaveCount(0)
  await expect(
    dialog.getByRole('button', { name: 'Replace credentials', exact: true }),
  ).toBeVisible()
  await expect(dialog.getByText(/Welcome|Restore|Connect your broker/u)).toHaveCount(0)
  await expect(dialog.locator('form,input')).toHaveCount(0)
  await expect(dialog.getByText(/Credentials stay on this computer/u)).toBeVisible()
  await expect(dialog.getByText(/separate licences/u)).toHaveCount(0)
  await expect(dialog.getByText('Licences and data information', { exact: true })).toHaveCount(0)
  for (const width of [900, 400, 320]) await expectContained(page, dialog, width)
  await dialog.screenshot({ path: test.info().outputPath('application-settings-ready-narrow.png') })
})

test('explicit replacement stays readable and clears unsubmitted credentials on cancel and close', async ({
  page,
  request,
}) => {
  await openTerminalSession(request)
  let replacements = 0
  await page.route('**/api/v1/setup/sdk', async (route) => {
    if (route.request().method() === 'PUT') replacements += 1
    await route.abort('blockedbyclient')
  })
  const dialog = await openSettings(page)
  const openReplacement = async () => {
    await dialog.getByRole('button', { name: 'Replace credentials', exact: true }).click()
    await expect(dialog.getByLabel('Client key', { exact: true })).toHaveValue('')
    await expect(dialog.getByLabel('Secret', { exact: true })).toHaveValue('')
    await expect(dialog.getByLabel('Secret', { exact: true })).toHaveAttribute('type', 'password')
    await expect(
      dialog.getByRole('button', { name: 'Update SDK credentials', exact: true }),
    ).toBeDisabled()
  }
  await openReplacement()
  await expectContained(page, dialog, 320)
  await dialog.getByLabel('Client key', { exact: true }).fill('unsubmitted-synthetic-id')
  await dialog.getByLabel('Secret', { exact: true }).fill('unsubmitted-synthetic-secret')
  await dialog.getByRole('button', { name: 'Cancel replacement', exact: true }).click()
  await expect(dialog.locator('input')).toHaveCount(0)
  await openReplacement()
  await dialog.getByLabel('Client key', { exact: true }).fill('unsubmitted-synthetic-id')
  await dialog.getByLabel('Secret', { exact: true }).fill('unsubmitted-synthetic-secret')
  await dialog.getByRole('button', { name: 'Close application settings', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.setViewportSize({ width: 900, height: 850 })
  await page.getByRole('button', { name: 'SDK settings', exact: true }).click()
  await expect(dialog.locator('input')).toHaveCount(0)
  await openReplacement()
  await expectContained(page, dialog, 400)
  await dialog.screenshot({
    path: test.info().outputPath('application-settings-replacement-blank.png'),
  })
  expect(replacements, 'Unsubmitted replacement must never change stored credentials').toBe(0)
})

test('rejected-access recovery accurately prompts restoration while preserving saved settings', async ({
  page,
  request,
}) => {
  await openTerminalSession(request)
  await page.route('**/api/v1/setup', (route) =>
    route.fulfill({
      json: {
        sdk: {
          configured: true,
          ready: false,
          state: 'error',
          failure: 'rejected',
          failureReason: 'unauthorized',
          version: '0.1.34',
        },
        connectionConfigured: true,
      },
    }),
  )
  let replacements = 0
  await page.route('**/api/v1/setup/sdk', async (route) => {
    replacements += 1
    await route.abort('blockedbyclient')
  })
  await page.goto('/')
  const setup = page.getByRole('region', { name: 'Workstation setup', exact: true })
  await expect(setup.getByText('Restore SDK access', { exact: true })).toBeVisible()
  await expect(
    page
      .getByRole('region', { name: 'Notifications', exact: true })
      .getByText('SDK credentials need updating', { exact: true }),
  ).toBeVisible()
  await expect(
    setup.getByText('Your broker connection settings and saved workspace are preserved.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(setup.getByLabel('Client key', { exact: true })).toHaveValue('')
  await expect(setup.getByLabel('Secret', { exact: true })).toHaveValue('')
  await expect(
    setup.getByText('Welcome to IBKR Tradescript Terminal', { exact: true }),
  ).toHaveCount(0)
  await page.setViewportSize({ width: 400, height: 850 })
  await expect(setup).toBeVisible()
  await setup.screenshot({ path: test.info().outputPath('application-settings-recovery.png') })
  expect(replacements).toBe(0)
  await test.info().attach('recovery-fixture-boundary', {
    body: JSON.stringify({
      setupResponseInjected: true,
      credentialReplacements: 0,
      nativeAuthorizationRejectionQualified: false,
    }),
    contentType: 'application/json',
  })
  // The recovery page deliberately does not mount a workstation. Return to the
  // unchanged real ready gateway before checking the actual source SDK ownership.
  await page.unroute('**/api/v1/setup')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: 'SDK settings', exact: true })).toBeVisible()
  if (process.env.TERMINAL_E2E_SOURCE_MODE === '1')
    await expect.poll(() => sourcePages.has(page)).toBe(true)
})
