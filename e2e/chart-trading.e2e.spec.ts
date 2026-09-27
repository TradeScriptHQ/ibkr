import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'

async function waitForTerminal(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.terminal-host')).toHaveAttribute(
    'data-trading-operation-support',
    /getState/,
    { timeout: 45_000 },
  )
  await expect(page.getByText('Workstation unavailable')).toHaveCount(0)
  await expect(page.getByRole('img', { name: /financial chart/u })).toBeVisible()
}

async function openChartOrderDraft(page: Page, verticalRatio = 0.3): Promise<number> {
  const chart = page.getByRole('img', { name: /financial chart/u })
  const box = await chart.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error('The chart did not expose a drawable bounding box.')

  const target = { x: box.x + box.width * 0.76, y: box.y + box.height * verticalRatio }
  await page.mouse.move(box.x + 4, box.y + 4)
  await page.mouse.move(target.x, target.y, { steps: 12 })
  const priceAction = page.getByRole('button', { name: /Open price actions at/u })
  await expect(
    priceAction,
    'Chart entry must be created through the visible price action',
  ).toBeVisible()
  const label = await priceAction.getAttribute('aria-label')
  const price = Number(label?.match(/at\s+([\d.]+)/u)?.[1])
  expect(price).toBeGreaterThan(0)
  await priceAction.click()
  await page.getByRole('menuitem', { name: /Add order on APPLE INC at/u }).click()
  await expect(page.locator('[aria-label="Drag entry order line"]')).toBeVisible()
  return price
}

async function configureChartDraftWithTwoExitLevels(
  page: Page,
  prices?: {
    entry: number
    takeProfits: readonly [number, number]
    stopLosses: readonly [number, number]
  },
  side: 'buy' | 'sell' = 'buy',
  quantity = 2,
  levelQuantities: readonly [number, number] = [1, 1],
): Promise<void> {
  const chartRegion = page.getByRole('region', { name: 'IBKR Chart' })
  const ticket = page.getByRole('region', { name: 'Order Entry' })

  await chartRegion
    .getByRole('group', { name: 'Select side' })
    .getByRole('button', { name: side === 'buy' ? 'Buy' : 'Sell', exact: true })
    .click()
  await chartRegion.getByRole('spinbutton', { name: 'Quantity' }).fill(String(quantity))
  await chartRegion.getByRole('button', { name: 'TP', exact: true }).click()
  await chartRegion.getByRole('button', { name: 'SL', exact: true }).click()

  if (prices) {
    await ticket.getByRole('textbox', { name: 'Price' }).fill(prices.entry.toFixed(2))
  }
  await ticket.getByRole('button', { name: '+ Add level', exact: true }).click()
  await expect(ticket.getByText('Exit levels', { exact: true })).toBeVisible()

  const quantities = ticket.getByRole('textbox', { name: 'Qty' })
  await expect(quantities).toHaveCount(2)
  await quantities.nth(0).fill(String(levelQuantities[0]))
  await quantities.nth(1).fill(String(levelQuantities[1]))

  if (prices) {
    const takeProfits = ticket.getByRole('textbox', { name: 'Take Profit' })
    const stopLosses = ticket.getByRole('textbox', { name: 'Stop Loss' })
    await expect(takeProfits).toHaveCount(2)
    await expect(stopLosses).toHaveCount(2)
    await takeProfits.nth(0).fill(prices.takeProfits[0].toFixed(2))
    await takeProfits.nth(1).fill(prices.takeProfits[1].toFixed(2))
    await stopLosses.nth(0).fill(prices.stopLosses[0].toFixed(2))
    await stopLosses.nth(1).fill(prices.stopLosses[1].toFixed(2))
  }

  const confirm = ticket.getByRole('button', { name: 'Confirm', exact: true })
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(
    ticket.getByRole('button', {
      name: side === 'buy' ? /LMT Buy AAPL/u : /LMT Sell AAPL/u,
    }),
  ).toBeVisible()
}

async function dragLine(page: Page, line: Locator, deltaY: number): Promise<void> {
  const box = await line.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error('The chart trading line did not expose a draggable bounding box.')
  const x = box.x + Math.min(Math.max(box.width * 0.35, 40), box.width - 40)
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + deltaY, { steps: 8 })
  await page.mouse.up()
}

test.describe('chart-native trading workflows', () => {
  test('drags a chart entry and paired TP/SL while keeping the native ticket synchronized', async ({
    page,
  }) => {
    await waitForTerminal(page)
    const chartPrice = await openChartOrderDraft(page)
    const chartRegion = page.getByRole('region', { name: 'IBKR Chart' })
    const ticket = page.getByRole('region', { name: 'Order Entry' })
    await chartRegion
      .getByRole('group', { name: 'Select side' })
      .getByRole('button', { name: 'Buy', exact: true })
      .click()
    await chartRegion.getByRole('button', { name: 'TP', exact: true }).click()
    await chartRegion.getByRole('button', { name: 'SL', exact: true }).click()
    await ticket.getByRole('textbox', { name: 'Price' }).fill(chartPrice.toFixed(2))
    await ticket.getByRole('textbox', { name: 'Take Profit' }).fill((chartPrice + 0.4).toFixed(2))
    await ticket.getByRole('textbox', { name: 'Stop Loss' }).fill((chartPrice - 0.4).toFixed(2))

    const entryLine = page.locator('[aria-label="Drag entry order line"]')
    const takeProfitLine = page.locator('[aria-label="Drag take profit order line"]')
    const stopLossLine = page.locator('[aria-label="Drag stop loss order line"]')
    await expect(entryLine).toHaveCount(1)
    await expect(takeProfitLine).toHaveCount(1)
    await expect(stopLossLine).toHaveCount(1)

    const entryPrice = ticket.getByRole('textbox', { name: 'Price' })
    const beforeEntryDrag = Number(await entryPrice.inputValue())
    await dragLine(page, entryLine, -12)
    await expect.poll(async () => Number(await entryPrice.inputValue())).not.toBe(beforeEntryDrag)

    const beforeTakeProfitDrag = Number(
      await ticket.getByRole('textbox', { name: 'Take Profit' }).inputValue(),
    )
    await dragLine(page, takeProfitLine, -10)
    await expect
      .poll(async () =>
        Number(await ticket.getByRole('textbox', { name: 'Take Profit' }).inputValue()),
      )
      .not.toBe(beforeTakeProfitDrag)

    await chartRegion.getByRole('button', { name: 'Close order draft' }).click()
    await expect(entryLine).toHaveCount(0)
    await expect(takeProfitLine).toHaveCount(0)
    await expect(stopLossLine).toHaveCount(0)
  })

  test('creates and edits one entry with two TP/SL levels directly on the chart', async ({
    page,
  }) => {
    await waitForTerminal(page)
    const chartPrice = await openChartOrderDraft(page)
    await configureChartDraftWithTwoExitLevels(page, {
      entry: chartPrice,
      takeProfits: [chartPrice + 0.4, chartPrice + 0.8],
      stopLosses: [chartPrice - 0.4, chartPrice - 0.8],
    })

    const entryLine = page.locator('[aria-label="Drag entry order line"]')
    const takeProfitLines = page.locator('[aria-label="Drag take profit order line"]')
    const stopLossLines = page.locator('[aria-label="Drag stop loss order line"]')
    await expect(entryLine).toHaveCount(1)
    await expect(stopLossLines).toHaveCount(2)
    await expect(takeProfitLines).toHaveCount(2)

    const entryPrice = page.getByRole('region', { name: 'Order Entry' }).getByRole('textbox', {
      name: 'Price',
    })
    const beforeDrag = Number(await entryPrice.inputValue())
    await dragLine(page, entryLine, -12)
    await expect.poll(async () => Number(await entryPrice.inputValue())).not.toBe(beforeDrag)

    await dragLine(page, takeProfitLines.nth(0), -10)
    await expect(takeProfitLines).toHaveCount(2)
    await expect(stopLossLines).toHaveCount(2)

    await page
      .getByRole('region', { name: 'IBKR Chart' })
      .getByRole('button', {
        name: 'Close order draft',
      })
      .click()
    await expect(entryLine).toHaveCount(0)
    await expect(takeProfitLines).toHaveCount(0)
    await expect(stopLossLines).toHaveCount(0)
  })
})
