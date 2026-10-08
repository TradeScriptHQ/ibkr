import { expect, type Page } from '@playwright/test'

export async function chartDataButton(page: Page) {
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Chart data', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'SDK settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Application settings', exact: true })
  await expect(settings).toBeVisible()
  const button = settings.getByRole('button', { name: 'Chart data', exact: true })
  await expect(button).toBeEnabled()
  return button
}
