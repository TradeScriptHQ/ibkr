import { expect, test } from '@playwright/test'

test('selecting an option foregrounds its existing order tab', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  const chainTab = page.getByRole('tab', { name: /Options Chain/u })
  const orderTab = page.getByRole('tab', { name: /Options Order/u })
  await chainTab.click()

  const chain = page.getByRole('tabpanel', { name: /Options Chain/u })
  await expect(chain.getByText('Calls', { exact: true })).toBeVisible()
  await expect(orderTab).toHaveAttribute('aria-selected', 'false')

  await chain.getByRole('button', { name: '2.4500', exact: true }).first().click()

  await expect(orderTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: /Options Order/u })).toBeVisible()
})
