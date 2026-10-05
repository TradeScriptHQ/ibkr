import type { Locator, Page } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { browserHeaders, openTerminalSession } from './support/session.js'

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

async function openFundamentals(page: Page) {
  await page.goto('/')
  const tab = page.getByRole('tab').filter({ hasText: 'Fundamentals' })
  await expect(tab).toBeVisible({ timeout: 60_000 })
  await tab.click()
  const panel = page
    .getByRole('tabpanel', { name: /Fundamentals/u })
    .getByRole('region', { name: 'Fundamentals', exact: true })
  await expect(panel.locator('[data-fundamental-field]')).toHaveCount(7)
  await page
    .locator('.dv-groupview')
    .filter({ has: tab })
    .getByRole('button', { name: 'Maximize', exact: true })
    .click()
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible()
  return panel
}

async function layoutFacts(panel: Locator) {
  return panel.evaluate((element) => {
    const canvas = document.createElement('canvas'),
      context = canvas.getContext('2d')
    if (!context) throw new Error('Text measurement unavailable')
    const widget = element.closest<HTMLElement>('.ts-fundamentals-widget')
    if (!widget) throw new Error('Fundamentals widget container unavailable')
    const grid = element.querySelector('.ts-fundamentals-grid')
    if (!grid) throw new Error('Fundamentals grid unavailable')
    const gridRect = grid.getBoundingClientRect()
    const fields = [...element.querySelectorAll<HTMLElement>('[data-fundamental-field]')].map(
      (field) => {
        const label = field.querySelector('dt'),
          value = field.querySelector('dd')
        if (!label || !value) throw new Error('Fundamentals label/value unavailable')
        const rect = field.getBoundingClientRect(),
          lr = label.getBoundingClientRect(),
          vr = value.getBoundingClientRect()
        const fs = getComputedStyle(field),
          ls = getComputedStyle(label)
        const contentWidth =
          field.clientWidth - parseFloat(fs.paddingLeft) - parseFloat(fs.paddingRight)
        context.font = `${ls.fontWeight} ${ls.fontSize} ${ls.fontFamily}`
        const longestWord = Math.max(
          ...(label.textContent ?? '').split(/\s+/u).map((word) => context.measureText(word).width),
        )
        return {
          id: field.dataset.fundamentalField,
          labelWidth: lr.width,
          valueWidth: vr.width,
          contentWidth,
          requiredLabelWidth: Math.min(longestWord, contentWidth),
          stacked: vr.top >= lr.bottom - 0.5,
          fullGridWidth: Math.abs(rect.width - gridRect.width) < 2,
          overflow:
            field.scrollWidth > field.clientWidth + 1 ||
            value.scrollWidth > value.clientWidth + 1 ||
            label.scrollWidth > label.clientWidth + 1,
          valueContained: vr.left >= rect.left - 1 && vr.right <= rect.right + 1,
        }
      },
    )
    return {
      widgetWidth: widget.getBoundingClientRect().width,
      columns: new Set(
        [...element.querySelectorAll('[data-fundamental-field]')].map((field) =>
          Math.round(field.getBoundingClientRect().left),
        ),
      ).size,
      overflow: widget.scrollWidth > widget.clientWidth + 1,
      fields,
    }
  })
}

async function verifyWidth(page: Page, panel: Locator, width: number) {
  await page.setViewportSize({ width, height: 850 })
  await expect
    .poll(async () => Math.round((await layoutFacts(panel)).widgetWidth))
    .toBeLessThanOrEqual(width)
  await expect
    .poll(async () => Math.round((await layoutFacts(panel)).widgetWidth))
    .toBeGreaterThanOrEqual(width - 32)
  await verifyLayout(panel, width)
}

async function verifyLayout(panel: Locator, width: number) {
  await expect
    .poll(
      async () => {
        const facts = await layoutFacts(panel)
        return (
          facts.fields.every(
            (field) =>
              !field.overflow &&
              field.valueContained &&
              field.labelWidth + 1 >= field.requiredLabelWidth &&
              (!field.stacked ||
                (field.labelWidth + 1 >= field.contentWidth &&
                  field.valueWidth + 1 >= field.contentWidth)),
          ) && !facts.overflow
        )
      },
      {
        message:
          'Every fundamentals label must retain whole-word space and stacked fields must use the full column',
      },
    )
    .toBe(true)
  if (width <= 480)
    await expect
      .poll(async () => (await layoutFacts(panel)).columns, {
        message: 'Narrow fundamentals must use one field column',
      })
      .toBe(1)
  if (width >= 1000)
    await expect
      .poll(async () => (await layoutFacts(panel)).columns, {
        message: 'Wide fundamentals should regain multiple columns',
      })
      .toBeGreaterThan(1)
  if (width === 260)
    await expect
      .poll(async () =>
        (await layoutFacts(panel)).fields.every((field) => field.stacked && field.fullGridWidth),
      )
      .toBe(true)
  const facts = await layoutFacts(panel)
  await test.info().attach(`fundamentals-layout-${width}`, {
    body: JSON.stringify(facts),
    contentType: 'application/json',
  })
}

test('native fundamentals labels remain readable as the mounted panel narrows and widens', async ({
  page,
  request,
}) => {
  await openTerminalSession(request)
  const response = page.waitForResponse(
    (item) =>
      item.status() === 200 && new URL(item.url()).pathname === '/api/v1/ibkr/instrument-details',
  )
  const panel = await openFundamentals(page)
  const native = await (await response).json()
  expect(native.name).toBe('APPLE INC')
  expect(native.symbol.canonicalSymbol).toMatch(/^IBKR:[1-9][0-9]*$/u)
  await expect(panel.locator('[data-fundamental-field="name"]')).toContainText(native.name)
  for (const width of [1320, 960, 640, 620, 480, 400, 320, 1320])
    await verifyWidth(page, panel, width)
  await page.setViewportSize({ width: 400, height: 850 })
  await panel.screenshot({ path: test.info().outputPath('fundamentals-native-narrow.png') })
})

test('long fundamentals values wrap without squeezing labels or overflowing their column', async ({
  page,
  request,
}) => {
  await openTerminalSession(request)
  let nativeResponses = 0
  await page.route('**/api/v1/ibkr/instrument-details?**', async (route) => {
    const response = await request.get(route.request().url(), { headers: browserHeaders })
    expect(response.status()).toBe(200)
    const native = await response.json()
    nativeResponses += 1
    await route.fulfill({
      response,
      json: {
        ...native,
        name: 'SPIRAX GROUP PLC',
        industry: 'Industrial',
        category: 'Machinery-Diversified',
        subcategory: 'Machinery-General Industrial',
        source: 'responsive-layout-fixture',
      },
    })
  })
  const panel = await openFundamentals(page)
  await expect(panel.locator('[data-fundamental-field="subcategory"]')).toContainText(
    'Machinery-General Industrial',
  )
  expect(nativeResponses).toBeGreaterThan(0)
  for (const width of [1320, 960, 640, 620, 480, 400, 320, 1320])
    await verifyWidth(page, panel, width)
  // A fixed desktop viewport must also respond to the widget's own narrower host.
  await page.setViewportSize({ width: 1320, height: 850 })
  for (const width of [400, 260, 840, 1320]) {
    await panel.evaluate((element, containerWidth) => {
      const widget = element.closest<HTMLElement>('.ts-fundamentals-widget')
      if (!(widget instanceof HTMLElement))
        throw new Error('Fundamentals widget container unavailable')
      widget.style.width = `${containerWidth}px`
      widget.style.maxWidth = '100%'
    }, width)
    await expect
      .poll(async () => Math.round((await layoutFacts(panel)).widgetWidth))
      .toBeGreaterThanOrEqual(width - 2)
    await verifyLayout(panel, width)
  }
  await panel.evaluate((element) => {
    const widget = element.closest<HTMLElement>('.ts-fundamentals-widget')
    if (widget instanceof HTMLElement) {
      widget.style.removeProperty('width')
      widget.style.removeProperty('max-width')
    }
  })
  await page.setViewportSize({ width: 400, height: 850 })
  await panel.screenshot({ path: test.info().outputPath('fundamentals-long-values-narrow.png') })
})
