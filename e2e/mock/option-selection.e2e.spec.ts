import { expect, test } from '@playwright/test'

test('selecting an option opens a reusable contract chart beside the chain and foregrounds its order tab', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  const chainTab = page.getByRole('tab', { name: /Options Chain/u })
  const orderTab = page.getByRole('tab', { name: /Options Order/u })
  await chainTab.click()

  const chain = page.getByRole('tabpanel', { name: /Options Chain/u })
  await expect(chain.getByText('Calls', { exact: true })).toBeVisible()
  await expect(orderTab).toHaveAttribute('aria-selected', 'false')

  await chain.getByRole('button', { name: '2.4900', exact: true }).first().click()

  await expect(orderTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: /Options Order/u })).toBeVisible()

  const chart = page.getByTestId('terminal-contract-chart')
  await expect(chart).toHaveCount(1)
  await expect(chart).toHaveAttribute('data-contract-id', /^mock-option:/u)
  await expect(chart.getByRole('button', { name: 'Pin contract chart', exact: true })).toBeEnabled()
  await expect(chainTab).toHaveAttribute('aria-selected', 'true')
  await expect(chain).toBeVisible()
  const chainBounds = await chain.boundingBox()
  const chartBounds = await chart.boundingBox()
  const ticketBounds = await page.getByRole('tabpanel', { name: /Options Order/u }).boundingBox()
  if (!chainBounds || !chartBounds || !ticketBounds)
    throw new Error('Chain, contract chart and option ticket must be visible')
  expect(chartBounds.x).toBeGreaterThanOrEqual(chainBounds.x + chainBounds.width - 1)
  const analysisWidth = chainBounds.width + chartBounds.width
  expect(chartBounds.width / analysisWidth).toBeGreaterThan(0.35)
  expect(chartBounds.width / analysisWidth).toBeLessThan(0.45)
  expect(chartBounds.x + chartBounds.width).toBeLessThanOrEqual(ticketBounds.x + 1)
  const firstContract = await chart.getAttribute('data-contract-id')

  await chart.getByRole('button', { name: 'Pin contract chart', exact: true }).click()
  const nextStrike = chain.getByText('205.00', { exact: true }).locator('..')
  await nextStrike
    .getByRole('button', { name: /^\d+\.\d+$/u })
    .first()
    .click()
  await expect(chart).toHaveAttribute('data-contract-id', firstContract ?? '')
  await expect(
    chart.getByRole('button', { name: 'Unpin contract chart', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await chart.getByRole('button', { name: 'Unpin contract chart', exact: true }).click()
  await expect(chart).not.toHaveAttribute('data-contract-id', firstContract ?? '')
  await expect(chart).toHaveCount(1)
  await expect(chain).toBeVisible()

  const markets = page
    .locator('.dv-groupview')
    .filter({ has: page.getByRole('tab', { name: /Markets/u }) })
  const fundamentals = page
    .locator('.dv-groupview')
    .filter({ has: page.getByRole('tab', { name: /Fundamentals/u }) })
  const chartGroup = page.locator('.dv-groupview').filter({ has: chart })
  const beforeClose = {
    markets: await markets.boundingBox(),
    fundamentals: await fundamentals.boundingBox(),
    ticket: await page.getByRole('tabpanel', { name: /Options Order/u }).boundingBox(),
    chain: await chain.boundingBox(),
    chart: await chartGroup.boundingBox(),
  }
  await chartGroup.getByRole('button', { name: 'Close group', exact: true }).click()
  await expect(chart).toHaveCount(0)
  for (const [panel, before] of [
    [markets, beforeClose.markets],
    [fundamentals, beforeClose.fundamentals],
    [page.getByRole('tabpanel', { name: /Options Order/u }), beforeClose.ticket],
  ] as const) {
    if (!before)
      throw new Error('Workspace rails must be visible before closing the contract chart')
    await expect.poll(async () => (await panel.boundingBox())?.width).toBeCloseTo(before.width, 0)
  }
  if (!beforeClose.chain || !beforeClose.chart)
    throw new Error('Chain and contract chart must be visible before closing')
  const expandedWidth = beforeClose.chain.width + beforeClose.chart.width
  await expect
    .poll(async () => (await chain.boundingBox())?.width)
    .toBeGreaterThanOrEqual(expandedWidth - 1)
  await nextStrike
    .getByRole('button', { name: /^\d+\.\d+$/u })
    .first()
    .click()
  await expect(chart).toHaveCount(1)
  await expect(chain).toBeVisible()
})
