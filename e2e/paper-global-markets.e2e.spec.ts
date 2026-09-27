import type {
  MarketQuote,
  MarketSessionInfo,
  MarketSymbol,
  SymbolSearchResult,
} from '@ibkr-terminal/contracts'
import type { APIRequestContext, Page } from '@playwright/test'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import { expect, test } from './support/fixtures.js'
import {
  accepted,
  cleanUp,
  modifyLimit,
  positionQuantities,
  readState,
  submit,
  verifyMarketFill,
} from './support/paper-orders.js'
import { browserHeaders, expectJsonOk, openTerminalSession } from './support/session.js'

const instruments = [
  {
    ticker: 'SAP',
    exchange: 'SMART',
    listedExchange: 'IBIS',
    currency: 'EUR',
    type: 'stock' as const,
    quantity: 1,
  },
  {
    ticker: 'USDHKD',
    exchange: 'IDEALPRO',
    currency: 'HKD',
    type: 'forex' as const,
    quantity: 1000,
  },
]

test.beforeEach(async ({ request }) => {
  await openTerminalSession(request)
})

function queryFor(instrument: TradingOrderDraft['symbol']) {
  return new URLSearchParams({
    symbol: instrument.ticker,
    exchange: instrument.exchange ?? '',
    primaryExchange: instrument.listedExchange ?? '',
    currency: instrument.currency ?? '',
    assetClass: instrument.type ?? '',
  })
}

async function sessionFor(request: APIRequestContext, symbol: TradingOrderDraft['symbol']) {
  const session = await expectJsonOk<MarketSessionInfo>(
    await request.get(`/api/v1/ibkr/sessions?${queryFor(symbol)}`, { headers: browserHeaders }),
  )
  expect(session.source).toBe('ibkr-contract-details')
  expect(session.symbol).toMatchObject({
    ticker: symbol.ticker,
    currency: symbol.currency,
    type: symbol.type,
  })
  return session
}

async function selectInstrument(page: Page, symbol: TradingOrderDraft['symbol'], navigate = true) {
  if (navigate) await page.goto('/')
  await page.getByRole('button', { name: /^Change symbol / }).click({ timeout: 60_000 })
  await page.getByPlaceholder('Symbol', { exact: true }).fill(symbol.ticker)
  const venue = symbol.listedExchange ?? symbol.exchange
  if (!venue) throw new Error('Missing broker venue')
  await page.getByRole('button', { name: venue, exact: true }).click()
  await page
    .getByRole('listitem')
    .filter({ hasText: venue })
    .filter({ has: page.getByText(symbol.currency ?? '', { exact: true }) })
    .filter({ has: page.getByText(symbol.ticker, { exact: true }) })
    .click()
  const ticket = page.getByRole('region', { name: 'Order Entry' })
  await ticket.getByRole('button', { name: 'LMT', exact: true }).click()
  await expect(
    ticket.getByRole('button', { name: `LMT Buy ${symbol.ticker}`, exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /^Change symbol / })).toContainText(
    `/${symbol.currency}`,
  )
}

async function quoteFor(request: APIRequestContext, symbol: TradingOrderDraft['symbol']) {
  let quote: MarketQuote | undefined
  await expect
    .poll(
      async () => {
        const quotes = await expectJsonOk<MarketQuote[]>(
          await request.get(`/api/v1/ibkr/quotes?fresh=true&${queryFor(symbol)}`, {
            headers: browserHeaders,
          }),
        )
        quote = quotes.find(
          (q) => q.symbol.symbol === symbol.ticker && q.symbol.currency === symbol.currency,
        )
        return Boolean(quote?.ibkrErrorCode || quote?.bid || quote?.ask || quote?.previousClose)
      },
      { timeout: 35_000 },
    )
    .toBe(true)
  if (!quote) throw new Error('Missing broker quote state')
  test.skip(
    [354, 10089, 10167].includes(quote.ibkrErrorCode ?? 0),
    `IBKR ${quote.ibkrErrorCode}: ${quote.unavailableReason}`,
  )
  return quote
}

for (const instrument of instruments) {
  test(`${instrument.ticker} ${instrument.currency}: native selection preserves the broker listing across reload`, async ({
    page,
    request,
  }) => {
    let canonicalSymbol: string | undefined
    await test.step('Find and qualify the exact listing with TWS', async () => {
      const results = await expectJsonOk<SymbolSearchResult[]>(
        await request.get(`/api/v1/ibkr/symbols/search?query=${instrument.ticker}`, {
          headers: browserHeaders,
        }),
      )
      expect(
        results.some(
          (result) =>
            result.symbol.ticker === instrument.ticker &&
            result.symbol.currency === instrument.currency,
        ),
      ).toBe(true)
      const resolved = await expectJsonOk<MarketSymbol>(
        await request.get(`/api/v1/ibkr/symbols/resolve?${queryFor(instrument)}`, {
          headers: browserHeaders,
        }),
      )
      expect(resolved).toMatchObject({
        ticker: instrument.ticker,
        currency: instrument.currency,
        type: instrument.type,
      })
      expect(resolved.canonicalSymbol).toMatch(/^IBKR:\d+$/)
      canonicalSymbol = resolved.canonicalSymbol
      await sessionFor(request, instrument)
    })
    await test.step('Select the instrument in the native terminal and reload', async () => {
      if (instrument.type === 'stock') {
        await selectInstrument(page, { ...instrument, currency: 'USD', listedExchange: 'NYSE' })
        const previous = await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('ibkr-terminal:last-instrument:v1') ?? '{}')
              .canonicalSymbol,
        )
        expect(previous).not.toBe(canonicalSymbol)
        await selectInstrument(page, instrument, false)
      } else await selectInstrument(page, instrument)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              JSON.parse(localStorage.getItem('ibkr-terminal:last-instrument:v1') ?? '{}')
                .canonicalSymbol,
          ),
        )
        .toBe(canonicalSymbol)
      await page.reload()
      await expect(page.getByRole('button', { name: /^Change symbol / })).toContainText(
        `/${instrument.currency}`,
        { timeout: 60_000 },
      )
      await expect(
        page
          .getByRole('region', { name: 'Order Entry' })
          .getByRole('button', { name: new RegExp(`Buy ${instrument.ticker}$`) }),
      ).toBeVisible()
    })
  })

  for (const execution of [false, true]) {
    test(`${instrument.ticker} ${instrument.currency}: ${execution ? 'market fill and test-owned close' : 'limit placement, modification and cancellation'} @paper`, async ({
      page,
      request,
    }) => {
      test.setTimeout(240_000)
      const session = await sessionFor(request, instrument)
      if (execution || instrument.type === 'forex')
        test.skip(session.currentState !== 'regular', `TWS session is ${session.currentState}`)
      const quote = execution ? undefined : await quoteFor(request, instrument)
      if (quote) {
        expect(['ok', 'delayed']).toContain(quote.status)
        expect(quote.bid ?? quote.previousClose).toBeGreaterThan(0)
        test.info().annotations.push({
          type: 'IBKR reference data',
          description: `${instrument.ticker}: ${quote.status}; only used to keep the limit order away from the market`,
        })
      }
      const reference = quote?.bid ?? quote?.previousClose
      if (!execution && !reference) throw new Error('No broker reference price for the limit order')
      const tick = session.symbol.minTick
      if (!tick) throw new Error('Missing broker price increment')
      // Whole-currency stock prices avoid assuming minTick describes every price band.
      const price =
        instrument.type === 'stock'
          ? Math.floor(Number(reference) * 0.98)
          : Number((Math.floor((Number(reference) * 0.999) / tick) * tick).toFixed(8))
      const draft: TradingOrderDraft = {
        symbol: instrument,
        side: 'buy',
        type: execution ? 'market' : 'limit',
        quantity: instrument.quantity,
        duration: { type: 'day' },
        ...(!execution ? { price } : {}),
      }
      await selectInstrument(page, instrument)
      const baseline = positionQuantities(await readState(request))
      let id: string | undefined
      try {
        await test.step('Preview and submit through the mounted SDK', async () => {
          id = await submit(page, draft)
        })
        if (!id) throw new Error('Missing order receipt')
        const orderId = id
        await test.step('Require broker acknowledgement and instrument-currency readback', async () => {
          const [order] = await accepted(request, orderId, 1)
          expect(order?.symbol).toMatchObject({
            symbol: instrument.ticker,
            currency: instrument.currency,
            assetClass: instrument.type,
          })
          expect(order?.quantity).toBe(instrument.quantity)
        })
        if (execution)
          await test.step('Require a filled order and execution', () =>
            verifyMarketFill(request, orderId))
        else
          await test.step('Modify the price and require a new TWS callback', () =>
            modifyLimit(
              page,
              request,
              orderId,
              Number((price - (instrument.type === 'stock' ? 1 : tick)).toFixed(8)),
              instrument,
            ))
      } finally {
        const cleanupId = id
        if (cleanupId)
          await test.step('Cancel remaining orders and close only test-owned fills', () =>
            cleanUp(page, request, cleanupId, draft))
        await expect
          .poll(async () => positionQuantities(await readState(request)), { timeout: 30_000 })
          .toEqual(baseline)
      }
      if (!execution) {
        const order = (await readState(request)).ordersHistory?.find((order) => order.id === id)
        expect(order?.status).toBe('cancelled')
      }
    })
  }
}
