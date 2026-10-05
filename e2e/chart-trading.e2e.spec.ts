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

interface ChartDraftPrices {
  entry: number
  takeProfits: readonly [number, number]
  stopLosses: readonly [number, number]
}

async function openChartOrderDraft(page: Page, verticalRatio = 0.5): Promise<ChartDraftPrices> {
  const chart = page.getByRole('img', { name: /financial chart/u })
  const box = await chart.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error('The chart did not expose a drawable bounding box.')

  const target = { x: box.x + box.width * 0.76, y: box.y + box.height * verticalRatio }
  await page.mouse.move(box.x + 4, box.y + 4)
  const priceAction = page.getByRole('button', { name: /Open price actions at/u })
  let previousPriceLabel: string | null = null
  const priceAt = async (offset: number) => {
    const y = target.y + offset
    expect(y).toBeGreaterThan(box.y)
    expect(y).toBeLessThan(box.y + box.height)
    await page.mouse.move(target.x, y, { steps: 12 })
    await expect(
      priceAction,
      'Chart draft prices must come from the visible price action',
    ).toBeVisible()
    if (previousPriceLabel !== null)
      await expect(priceAction).not.toHaveAttribute('aria-label', previousPriceLabel)
    let settledLabel: string | null = null
    let stableReads = 0
    await expect
      .poll(
        async () => {
          const label = await priceAction.getAttribute('aria-label')
          stableReads = label === settledLabel ? stableReads + 1 : 0
          settledLabel = label
          return stableReads
        },
        {
          message: 'The visible hover price must settle before being used as a draft level',
          intervals: [50, 100, 200],
        },
      )
      .toBeGreaterThanOrEqual(2)
    const label = await priceAction.getAttribute('aria-label')
    previousPriceLabel = label
    const price = Number(label?.match(/at\s+([\d.]+)/u)?.[1])
    expect(price).toBeGreaterThan(0)
    return price
  }
  // Keep sampled points in the middle of the plot, away from the header/legend.
  // Fixed dollar offsets can put exits under another level's active hit strip.
  const gap = Math.min(72, box.height * 0.12)
  const takeProfit = await priceAt(-gap)
  const secondTakeProfit = await priceAt(-gap * 1.5)
  const stopLoss = await priceAt(gap)
  const secondStopLoss = await priceAt(gap * 1.5)
  const entry = await priceAt(0)
  expect(secondTakeProfit).toBeGreaterThan(takeProfit)
  expect(takeProfit).toBeGreaterThan(entry)
  expect(entry).toBeGreaterThan(stopLoss)
  expect(stopLoss).toBeGreaterThan(secondStopLoss)
  await priceAction.click()
  await page.getByRole('menuitem', { name: /Add order on APPLE INC at/u }).click()
  await expect(page.locator('[aria-label="Drag entry order line"]')).toBeVisible()
  return {
    entry,
    takeProfits: [takeProfit, secondTakeProfit],
    stopLosses: [stopLoss, secondStopLoss],
  }
}

async function configureChartDraftWithTwoExitLevels(
  page: Page,
  prices?: ChartDraftPrices,
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
    await stopLosses.nth(1).press('Tab')
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
  await expect(
    line.evaluate(
      (element, point) => {
        const target = document.elementFromPoint(point.x, point.y)
        return target === element || (target !== null && element.contains(target))
      },
      { x, y },
    ),
    'The drag point must hit the requested visible line rather than another draft level',
  ).resolves.toBe(true)
  await page.mouse.down()
  await page.mouse.move(x, y + deltaY, { steps: 8 })
  await page.mouse.up()
}

test.describe('chart-native trading workflows', () => {
  test('drags a chart entry and paired TP/SL while keeping the native ticket synchronized', async ({
    page,
  }) => {
    await waitForTerminal(page)
    const prices = await openChartOrderDraft(page)
    const chartRegion = page.getByRole('region', { name: 'IBKR Chart' })
    const ticket = page.getByRole('region', { name: 'Order Entry' })
    await chartRegion
      .getByRole('group', { name: 'Select side' })
      .getByRole('button', { name: 'Buy', exact: true })
      .click()
    await chartRegion.getByRole('button', { name: 'TP', exact: true }).click()
    await chartRegion.getByRole('button', { name: 'SL', exact: true }).click()
    await ticket.getByRole('textbox', { name: 'Price' }).fill(prices.entry.toFixed(2))
    await ticket
      .getByRole('textbox', { name: 'Take Profit' })
      .fill(prices.takeProfits[0].toFixed(2))
    await ticket.getByRole('textbox', { name: 'Stop Loss' }).fill(prices.stopLosses[0].toFixed(2))
    // Finish editing before switching to the chart. A focused numeric field
    // preserves its editing text until blur, while chart drags retain focus.
    await ticket.getByRole('textbox', { name: 'Stop Loss' }).press('Tab')

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

    const stopLossPrice = ticket.getByRole('textbox', { name: 'Stop Loss' })
    const beforeStopLossDrag = Number(await stopLossPrice.inputValue())
    await dragLine(page, stopLossLine, 10)
    await expect
      .poll(async () => Number(await stopLossPrice.inputValue()))
      .not.toBe(beforeStopLossDrag)

    await chartRegion.getByRole('button', { name: 'Close order draft' }).click()
    await expect(entryLine).toHaveCount(0)
    await expect(takeProfitLine).toHaveCount(0)
    await expect(stopLossLine).toHaveCount(0)
  })

  test('creates and edits one entry with two TP/SL levels directly on the chart', async ({
    page,
  }) => {
    await waitForTerminal(page)
    const prices = await openChartOrderDraft(page)
    await configureChartDraftWithTwoExitLevels(page, prices)

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

    // Confirmed multi-level exits expose summary rows instead of price inputs.
    const firstExitLevel = page
      .getByRole('region', { name: 'Order Entry' })
      .getByRole('button', { name: 'Remove exit level 1', exact: true })
      .locator('..')
    const takeProfitPrice = async () => {
      const summary = await firstExitLevel.innerText()
      const price = Number(summary.match(/TP\s+[\d.]+\s+@\s+([\d.]+)/u)?.[1])
      expect(price).toBeGreaterThan(0)
      return price
    }
    const beforeTakeProfitDrag = await takeProfitPrice()
    await dragLine(page, takeProfitLines.nth(0), -10)
    await expect.poll(takeProfitPrice).not.toBe(beforeTakeProfitDrag)
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
