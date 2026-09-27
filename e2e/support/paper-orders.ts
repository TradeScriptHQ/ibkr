import type { BrokerState, BrokerSymbol, MarketQuote, Order } from '@ibkr-terminal/contracts'
import type { APIRequestContext, Page } from '@playwright/test'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import { expect, test } from './fixtures.js'
import { ownsOrder } from './order-safety.js'
import { assetCloseDraft, optionCloseDraft, remainingOwnedFill } from './paper-cleanup.js'
import { browserHeaders, expectJsonOk, readBrokerState as readState } from './session.js'

const symbol = {
  ticker: 'AAPL',
  brokerSymbol: 'AAPL',
  exchange: 'SMART',
  listedExchange: 'NASDAQ',
  currency: 'USD',
  type: 'stock' as const,
}
async function stockReferenceQuote(request: APIRequestContext): Promise<MarketQuote> {
  let quote: MarketQuote | undefined
  await expect
    .poll(
      async () => {
        const quotes = (await expectJsonOk(
          await request.get(
            '/api/v1/ibkr/quotes?fresh=true&symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock',
            { headers: browserHeaders },
          ),
        )) as BrokerState['quotes']
        quote = quotes[0]
        return (
          quote?.ibkrErrorCode ??
          quote?.last ??
          quote?.bid ??
          quote?.ask ??
          quote?.previousClose ??
          0
        )
      },
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toBeGreaterThan(0)
  if (!quote) throw new Error('TWS returned no stock quote state')
  test.skip(
    quote.status === 'unavailable' && [354, 10089, 10167].includes(quote.ibkrErrorCode ?? 0),
    `IBKR ${quote.ibkrErrorCode}: ${quote.unavailableReason}`,
  )
  expect(['ok', 'delayed']).toContain(quote.status)
  return quote
}

async function stockReference(request: APIRequestContext): Promise<number> {
  const quote = await stockReferenceQuote(request)
  const reference = quote.last ?? quote.bid ?? quote.ask ?? quote.previousClose
  if (reference === undefined) throw new Error('TWS returned no stock reference price')
  return reference
}

async function submit(page: Page, draft: TradingOrderDraft): Promise<string> {
  return page.evaluate(async (draft) => {
    const params = new URLSearchParams({
      symbol: draft.symbol.brokerSymbol ?? draft.symbol.ticker,
      exchange: draft.symbol.exchange ?? '',
      primaryExchange: draft.symbol.listedExchange ?? '',
      currency: draft.symbol.currency ?? '',
      assetClass: draft.symbol.type ?? '',
    })
    const response = await fetch(`/api/v1/ibkr/symbols/resolve?${params}`, {
      headers: { 'x-tradescript-client': 'terminal-v1' },
    })
    if (!response.ok) throw new Error(`Instrument resolution failed: HTTP ${response.status}`)
    const resolved = await response.json()
    if (typeof resolved.canonicalSymbol !== 'string')
      throw new Error('Missing broker contract identity')
    draft = { ...draft, symbol: { ...draft.symbol, canonicalSymbol: resolved.canonicalSymbol } }
    const driver = window.__ibkrChartTradingE2E__
    if (!driver) throw new Error('The native SDK test driver is unavailable')
    const trading = await driver.getPaperTradingController()
    const state = await trading.getState()
    if (!state.activeAccountId) throw new Error('The SDK has no active paper account')
    const context = {
      symbol: draft.symbol,
      accountId: state.activeAccountId,
      currency: draft.symbol.currency ?? 'USD',
    }
    const input = { ...draft, accountId: state.activeAccountId }
    const preview = await trading.previewOrder(input, context)
    if (!preview.accepted) throw new Error(preview.message ?? 'Preview rejected')
    const placed = await trading.placeOrder(
      { ...input, ...(preview.confirmId ? { confirmId: preview.confirmId } : {}) },
      context,
    )
    if (!placed.order) throw new Error('SDK placement returned no order receipt')
    return placed.order.id
  }, draft)
}

/** Require sustained broker acknowledgement; local `placing` and terminal failures never pass. */
async function accepted(
  request: APIRequestContext,
  id: string,
  expectedCount: number,
): Promise<Order[]> {
  const deadline = Date.now() + 45_000
  let acknowledgedAt: number | undefined
  while (Date.now() < deadline) {
    const state = await readState(request)
    const family = [...state.orders, ...(state.ordersHistory ?? [])].filter(
      (o) => o.id === id || o.parentId === id || o.bracketGroupId === id,
    )
    const failed = family.find((o) => ['rejected', 'cancelled', 'inactive'].includes(o.status))
    if (failed)
      throw new Error(
        `Broker ${failed.status}: ${failed.message ?? ''}; ${state.diagnostics
          .filter((d) => d.text.includes(id))
          .map((d) => d.text)
          .join('; ')}`,
      )
    if (
      family.length >= expectedCount &&
      family.every((o) => ['working', 'pre-submitted', 'filled'].includes(o.status))
    ) {
      acknowledgedAt ??= Date.now()
      if (Date.now() - acknowledgedAt >= 2500) return family
    } else acknowledgedAt = undefined
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`No sustained broker acknowledgement for order ${id}`)
}

/** Bracket prices can lie outside the initial candle range. Zoom the native price axis first. */
async function showOrderFamilyOnChart(page: Page, family: readonly Order[]): Promise<void> {
  const chart = page.getByRole('region', { name: 'IBKR Chart', exact: true })
  const lines = family.map((order) => chart.getByTestId(`chart-trading-order-line-${order.id}`))
  const scale = chart.getByLabel('Price scale main', { exact: true }).first()
  for (let attempt = 0; attempt < 10; attempt++) {
    if ((await Promise.all(lines.map((line) => line.isVisible()))).every(Boolean)) break
    const box = await scale.boundingBox()
    if (!box || box.height <= 0) throw new Error('The chart price scale is not visible')
    const x = box.x + box.width / 2
    await page.mouse.move(x, box.y + box.height * 0.15)
    await page.mouse.down()
    await page.mouse.move(x, box.y + box.height * 0.85, { steps: 12 })
    await page.mouse.up()
  }
  for (const line of lines) await expect(line).toBeVisible()
}

async function verifyMarketFill(request: APIRequestContext, id: string): Promise<void> {
  await waitForFilledOrder(request, id)
  await expect
    .poll(
      async () =>
        (await readState(request)).executions.some((execution) => execution.orderId === id),
      { timeout: 30_000 },
    )
    .toBe(true)
}

async function modifyLimit(
  page: Page,
  request: APIRequestContext,
  id: string,
  price: number,
  orderSymbol: TradingOrderDraft['symbol'] = symbol,
): Promise<void> {
  const before = new Set((await readState(request)).diagnostics.map((d) => d.id))
  await page.evaluate(
    async ({ id, price, symbol }) => {
      const driver = window.__ibkrChartTradingE2E__
      if (!driver) throw new Error('The native SDK test driver is unavailable')
      const trading = await driver.getPaperTradingController()
      const state = await trading.getState()
      if (!state.activeAccountId) throw new Error('The SDK has no active paper account')
      const order = state.orders.find((order) => order.id === id)
      if (!order) throw new Error('The SDK order is missing before modification')
      const context = {
        symbol: order.symbol,
        accountId: state.activeAccountId,
        currency: symbol.currency ?? 'USD',
      }
      const preview = await trading.previewModifyOrder(id, { price }, context)
      if (!preview.accepted) throw new Error(preview.message ?? 'Modification rejected')
      await trading.modifyOrder(
        id,
        { price, ...(preview.confirmId ? { confirmId: preview.confirmId } : {}) },
        context,
      )
    },
    { id, price, symbol: orderSymbol },
  )
  await expect
    .poll(
      async () => {
        const state = await readState(request)
        return (
          state.orders.some((order) => order.id === id && order.limitPrice === price) &&
          state.diagnostics.some(
            (d) => !before.has(d.id) && d.text.includes(`IBKR raw openOrder orderId=${id} `),
          )
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await accepted(request, id, 1)
}

async function cancelOrderFamily(
  page: Page,
  request: APIRequestContext,
  id: string,
  orderSymbol: TradingOrderDraft['symbol'] = symbol,
): Promise<void> {
  const state = await readState(request)
  const ownedIds = new Set([id])
  const family = state.orders.filter((order) => ownsOrder(order, ownedIds))
  // Cancel the parent first; TWS cancels its linked children. Cancel any remaining children separately.
  for (const order of family.sort((a, b) => Number(b.id === id) - Number(a.id === id))) {
    const current = await readState(request)
    if (!current.orders.some((o) => o.id === order.id)) continue
    await page.evaluate(
      async ({ id, symbol }) => {
        const driver = window.__ibkrChartTradingE2E__
        if (!driver) throw new Error('The native SDK test driver is unavailable')
        const trading = await driver.getPaperTradingController()
        const state = await trading.getState()
        if (!state.activeAccountId) throw new Error('The SDK has no active paper account')
        const order = state.orders.find((order) => order.id === id)
        if (!order) throw new Error('The SDK order is missing before cancellation')
        if (order.symbol.currency !== symbol.currency)
          throw new Error('Order currency changed before cancellation')
        await trading.cancelOrder(id, {
          symbol: order.symbol,
          accountId: state.activeAccountId,
          currency: symbol.currency ?? 'USD',
        })
      },
      { id: order.id, symbol: orderSymbol },
    )
  }
  await expect
    .poll(
      async () =>
        (await readState(request)).orders.filter((order) => ownsOrder(order, ownedIds)).length,
      { timeout: 30_000 },
    )
    .toBe(0)
}

async function waitForFilledOrder(request: APIRequestContext, id: string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const state = await readState(request)
    const order = [...state.orders, ...(state.ordersHistory ?? [])].find((order) => order.id === id)
    if (order?.status === 'filled') return
    if (order && ['rejected', 'cancelled', 'inactive'].includes(order.status))
      throw new Error(`Broker ${order.status}: ${order.message ?? 'Execution did not complete'}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Broker execution did not complete for test-owned order ${id}`)
}

/** Cancel remaining orders first, then reverse only this order family's recorded fills. */
async function cleanUp(
  page: Page,
  request: APIRequestContext,
  id: string,
  draft?: TradingOrderDraft,
  closingOrderIds: string[] = [],
): Promise<void> {
  const orderSymbol = draft?.symbol ?? symbol
  await cancelOrderFamily(page, request, id, orderSymbol)
  for (const closeId of closingOrderIds)
    await cancelOrderFamily(page, request, closeId, orderSymbol)
  const state = await readState(request)
  const ownedIds = new Set([id])
  const records = [...state.orders, ...(state.ordersHistory ?? [])].filter((order) =>
    ownsOrder(order, ownedIds),
  )
  const optionParent = records.find(
    (order) => order.id === id && (order.optionLegs?.length || order.strategyLegs?.length),
  )
  let closeDraft = optionParent
    ? optionCloseDraft(optionParent.filledQuantity ?? 0, draft)
    : assetCloseDraft(records, orderSymbol, { type: orderSymbol.type === 'crypto' ? 'ioc' : 'day' })
  if (!closeDraft) return
  const remaining = remainingOwnedFill(
    closeDraft.quantity,
    state.ordersHistory ?? [],
    closingOrderIds,
  )
  if (remaining === 0) return
  closeDraft = optionParent
    ? optionCloseDraft(remaining, draft)
    : { ...closeDraft, quantity: remaining }
  if (!closeDraft) return
  if (orderSymbol.type === 'event-contract' && orderSymbol.exchange === 'FORECASTX') {
    if (closeDraft.side !== 'sell') throw new Error('Unexpected short ForecastEx test fill')
    const opposite = await expectJsonOk<BrokerSymbol>(
      await request.get(
        `/api/v1/ibkr/contracts/opposing-outcome?${new URLSearchParams({ symbol: orderSymbol.brokerSymbol ?? orderSymbol.ticker, currency: orderSymbol.currency ?? '' })}`,
        { headers: browserHeaders },
      ),
    )
    if (
      !opposite.canonicalSymbol ||
      !opposite.contractIdentity?.localSymbol ||
      !opposite.currency ||
      !opposite.exchange
    )
      throw new Error('Missing opposing outcome identity during cleanup')
    let quote: MarketQuote | undefined
    await expect
      .poll(
        async () => {
          quote = (
            await expectJsonOk<MarketQuote[]>(
              await request.get(
                `/api/v1/ibkr/quotes?fresh=true&${new URLSearchParams({ symbol: opposite.canonicalSymbol!, exchange: opposite.exchange!, currency: opposite.currency!, assetClass: 'event-contract' })}`,
                { headers: browserHeaders },
              ),
            )
          )[0]
          return (
            quote?.status === 'ok' &&
            Number(quote.ask) >= 0.01 &&
            Number(quote.ask) <= 0.99 &&
            Date.now() - Date.parse(quote.timestamp) < 30_000
          )
        },
        { timeout: 30_000 },
      )
      .toBe(true)
    if (quote?.ask === undefined) throw new Error('Missing fresh opposing outcome ask')
    closeDraft = {
      ...closeDraft,
      side: 'buy',
      type: 'limit',
      price: quote.ask,
      symbol: {
        ticker: opposite.contractIdentity.localSymbol,
        brokerSymbol: opposite.canonicalSymbol,
        canonicalSymbol: opposite.canonicalSymbol,
        exchange: opposite.exchange,
        currency: opposite.currency,
        type: 'event-contract',
      },
    }
  }
  const closeId = await submit(page, closeDraft)
  await waitForFilledOrder(request, closeId)
}

function positionQuantities(state: BrokerState) {
  return Object.fromEntries(
    state.positions
      .filter((position) => position.quantity !== 0)
      .map((position) => [position.id, position.quantity])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )
}
async function requireRegularSession(request: APIRequestContext): Promise<void> {
  const session = await (
    await request.get(
      '/api/v1/ibkr/sessions?symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock',
      { headers: browserHeaders },
    )
  ).json()
  test.skip(
    session.currentState !== 'regular',
    `Execution requires the regular session; TWS reports ${session.currentState}.`,
  )
}

export {
  accepted,
  cancelOrderFamily,
  cleanUp,
  modifyLimit,
  positionQuantities,
  readState,
  requireRegularSession,
  showOrderFamilyOnChart,
  stockReference,
  stockReferenceQuote,
  submit,
  symbol,
  verifyMarketFill,
}
