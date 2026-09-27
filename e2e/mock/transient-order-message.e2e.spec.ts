import { expect, test } from '@playwright/test'

test('dismisses a filled-order message after the short notification timeout', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Simulated Workstation', { exact: true })).toBeVisible()

  const ticket = page.getByRole('region', { name: 'Order Entry' })
  await ticket.getByRole('button', { name: /Buy AAPL/u }).click()

  const filledMessage = ticket.getByText(/Filled by broker(?: at .+)?\./u)
  await expect(filledMessage).toBeVisible()
  await expect(filledMessage).toHaveCount(0, { timeout: 8_000 })
})
