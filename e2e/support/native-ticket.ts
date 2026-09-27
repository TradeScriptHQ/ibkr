import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

export async function openNativeTerminal(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.terminal-host')).toHaveAttribute(
    'data-trading-operation-support',
    /getState/,
    { timeout: 45_000 },
  )
}

export async function selectOptionContract(page: Page): Promise<Locator> {
  await page.getByRole('tab', { name: /Options Chain/u }).click()
  const chain = page.getByRole('tabpanel', { name: /Options Chain/u })
  await expect(chain.getByText('Calls', { exact: true })).toBeVisible({
    timeout: 60_000,
  })

  const expirationButtons = chain.locator('button').filter({ hasText: /\d+ days?$/u })
  const expirationLabels = await expirationButtons.allTextContents()
  const safeExpirationIndex = expirationLabels.findIndex((label) => {
    const days = Number(label.match(/(\d+) days?$/u)?.[1])
    return Number.isFinite(days) && days >= 4
  })
  expect(safeExpirationIndex).toBeGreaterThanOrEqual(0)
  await expirationButtons.nth(safeExpirationIndex).click()

  const quotedContracts = chain
    .locator('button[aria-pressed]')
    .filter({ hasText: /^\d+(?:\.\d+)?$/u })
  await expect(quotedContracts.first()).toBeVisible({ timeout: 60_000 })
  await quotedContracts.first().click()

  await page.getByRole('tab', { name: /Options Order/u }).click()
  const ticket = page.getByRole('tabpanel', { name: /Options Order/u })
  await expect(ticket.getByRole('textbox', { name: /Limit Price/u })).toBeVisible()
  await ticket.getByRole('textbox', { name: /Limit Price/u }).fill('0.01')

  return ticket
}

export async function configureGtdTicket(page: Page, ticket: Locator): Promise<Date> {
  await ticket.getByRole('combobox', { name: 'Duration', exact: true }).click()
  await page.getByRole('option', { name: 'GTD', exact: true }).click()
  const targetDate = new Date()
  targetDate.setDate(targetDate.getDate() + 2)
  targetDate.setHours(23, 59, 0, 0)
  const accessibleTargetDate = targetDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  await ticket.getByRole('combobox', { name: 'Expiry date' }).click()
  const targetDateButton = page.getByRole('button', {
    name: accessibleTargetDate,
    exact: true,
  })
  if (!(await targetDateButton.isVisible())) {
    await page.getByRole('button', { name: 'Next month', exact: true }).click()
  }
  await targetDateButton.click()
  await ticket.getByRole('combobox', { name: 'Expiry time' }).click()
  await page.getByRole('option', { name: '23 hours', exact: true }).click()
  await page.getByRole('option', { name: '59 minutes', exact: true }).click()
  await expect(ticket.getByRole('combobox', { name: 'Expiry time' })).toContainText('23:59')

  return targetDate
}
