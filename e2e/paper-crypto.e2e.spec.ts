import type { APIRequestContext, Page } from '@playwright/test'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import {
  type CryptoContract,
  type CryptoMarket,
  cleanUpCryptoOrders,
  cryptoLimit,
  cryptoTickers,
  currentCryptoPrices,
  expectCryptoOrder,
  loadCryptoContract,
  loadCryptoMarket,
  requireCryptoTrading,
} from './support/crypto-orders.js'
import { expect, test } from './support/fixtures.js'
import { assetCloseDraft } from './support/paper-cleanup.js'
import {
  accepted,
  cancelOrderFamily,
  modifyLimit,
  positionQuantities,
  readState,
  submit,
  verifyMarketFill,
} from './support/paper-orders.js'
import { openTerminalSession } from './support/session.js'

test.beforeEach(async ({ request }) => {
  await openTerminalSession(request)
})

async function selectCrypto(
  page: Page,
  market: CryptoContract,
  orderType: 'limit' | 'market' = 'limit',
) {
  await page.goto('/')
  await page.getByRole('button', { name: /^Change symbol / }).click({ timeout: 60_000 })
  await page.getByPlaceholder('Symbol', { exact: true }).fill(market.symbol.ticker)
  await page.getByRole('button', { name: 'PAXOS', exact: true }).click()
  await page.getByPlaceholder('Symbol', { exact: true }).press('Enter')
  const ticket = page.getByRole('region', { name: 'Order Entry' })
  const orderTypeLabel = orderType === 'market' ? 'MKT' : 'LMT'
  await ticket.getByRole('button', { name: orderTypeLabel, exact: true }).click()
  await expect(
    ticket.getByRole('button', {
      name: `${orderTypeLabel} Buy ${market.symbol.ticker}`,
      exact: true,
    }),
  ).toBeVisible()
  return ticket
}

async function verifyCancelled(request: APIRequestContext, id: string, market: CryptoMarket) {
  await expect
    .poll(async () => (await expectCryptoOrder(request, id, market)).status)
    .toBe('cancelled')
}

for (const ticker of cryptoTickers) {
  test(`${ticker}: native crypto selection preserves the venue and fractional quantity`, async ({
    page,
    request,
  }) => {
    const market = await test.step('Resolve the broker contract and increments', () =>
      loadCryptoContract(request, ticker))
    const ticket = await test.step('Select crypto through the native symbol picker', () =>
      selectCrypto(page, market))
    await ticket.getByRole('textbox', { name: 'Qty', exact: true }).fill('0.001')
    await expect(ticket.getByRole('textbox', { name: 'Qty', exact: true })).toHaveValue('0.001')
    await expect(page.getByRole('button', { name: /^Change symbol / })).toContainText(
      ticker === 'BTC' ? /Bitcoin/i : /Ethereum/i,
    )
  })

  test(`${ticker}: paper limit buy is acknowledged, modified and cancelled @paper`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const market = await loadCryptoMarket(request, ticker)
    const { bid, quantity } = requireCryptoTrading(market)
    await selectCrypto(page, market)
    const baseline = positionQuantities(await readState(request))
    const ids: string[] = []
    try {
      const draft = cryptoLimit(market, 'buy', quantity, bid * 0.98)
      const id =
        await test.step('Preview and submit the fractional crypto limit buy through the SDK', async () => {
          const id = await submit(page, draft)
          ids.push(id)
          return id
        })
      await test.step('Require TWS acknowledgement and exact crypto contract readback', async () => {
        await accepted(request, id, 1)
        const order = await expectCryptoOrder(request, id, market)
        expect(order.quantity).toBe(quantity)
        expect(order.duration).toBe('gtc')
      })
      await test.step('Modify the crypto limit price and await a new broker callback', () =>
        modifyLimit(
          page,
          request,
          id,
          Number(((draft.price ?? 0) - market.priceStep).toFixed(8)),
          market.symbol,
        ))
      await test.step('Cancel the test order and verify broker history', async () => {
        await cancelOrderFamily(page, request, id, market.symbol)
        await verifyCancelled(request, id, market)
      })
    } finally {
      await cleanUpCryptoOrders(page, request, ids, market)
      await expect
        .poll(async () => positionQuantities(await readState(request)), { timeout: 30_000 })
        .toEqual(baseline)
    }
  })

  test(`${ticker}: paper IOC buy fill, sell-limit lifecycle and market-sell close reconcile @paper`, async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000)
    const market = await loadCryptoMarket(request, ticker)
    const { ask, quantity } = requireCryptoTrading(market, { requireRealTime: true })
    await selectCrypto(page, market)
    const baseline = positionQuantities(await readState(request))
    const ids: string[] = []
    const place = async (draft: TradingOrderDraft) => {
      const id = await submit(page, draft)
      ids.push(id)
      return id
    }
    try {
      await test.step('Acquire only the test quantity with a marketable IOC limit buy', async () => {
        const id = await place(cryptoLimit(market, 'buy', quantity, ask * 1.01, true))
        await verifyMarketFill(request, id)
        const order = await expectCryptoOrder(request, id, market)
        expect(order.filledQuantity).toBe(quantity)
        expect(order.duration).toBe('ioc')
      })
      await test.step('Place, modify and cancel a sell limit against the test-owned quantity', async () => {
        const refreshed = await loadCryptoMarket(request, ticker)
        const { ask: currentAsk } = currentCryptoPrices(refreshed, { requireRealTime: true })
        const draft = cryptoLimit(market, 'sell', quantity, currentAsk * 1.02)
        const id = await place(draft)
        await accepted(request, id, 1)
        await expectCryptoOrder(request, id, market)
        await modifyLimit(
          page,
          request,
          id,
          Number(((draft.price ?? 0) + market.priceStep).toFixed(8)),
          market.symbol,
        )
        await cancelOrderFamily(page, request, id, market.symbol)
        await verifyCancelled(request, id, market)
      })
      await test.step('Sell the remaining test fills with an IOC market order and verify executions', async () => {
        const state = await readState(request)
        const records = [...state.orders, ...(state.ordersHistory ?? [])].filter((order) =>
          ids.includes(order.id),
        )
        const close = assetCloseDraft(records, market.symbol, { type: 'ioc' }, market.quantityStep)
        if (close?.side !== 'sell')
          throw new Error('No test-owned crypto quantity remains for market-sell verification')
        const id = await place(close)
        await verifyMarketFill(request, id)
        const order = await expectCryptoOrder(request, id, market)
        expect(order.type).toBe('market')
        expect(order.duration).toBe('ioc')
      })
    } finally {
      await cleanUpCryptoOrders(page, request, ids, market)
      await expect
        .poll(async () => positionQuantities(await readState(request)), { timeout: 30_000 })
        .toEqual(baseline)
    }
  })
}

test('BTC: native market-buy ticket maps a cash amount into preview and placement APIs without reaching TWS @paper', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const contract = await loadCryptoContract(request, 'BTC')
  const ticket = await selectCrypto(page, contract, 'market')
  const amount = ticket.getByRole('textbox', { name: 'Cash amount (USD)', exact: true })
  await expect(amount).toBeVisible()
  await amount.fill('25')
  await expect(ticket.getByText('IOC', { exact: true })).toBeVisible()

  await page.route('**/api/v1/ibkr/orders/preview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: true, source: 'broker' }),
    })
  })

  const previewResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/ibkr/orders/preview',
  )
  await ticket.getByRole('button', { name: 'MKT Buy BTC', exact: true }).click()
  const response = await previewResponse
  const body = response.request().postDataJSON() as {
    draft: { quantity: number; cashQuantity?: number; type: string; duration: string }
  }
  expect(body.draft).toMatchObject({
    type: 'market',
    duration: 'ioc',
    quantity: 0,
    cashQuantity: 25,
  })
  expect(await response.json()).toMatchObject({ accepted: true, source: 'broker' })
  const preview = page.getByRole('dialog', { name: 'Order Preview' })
  await expect(preview).toBeVisible()

  await page.route('**/api/v1/ibkr/orders', async (route) => {
    const requestBody = route.request().postDataJSON() as {
      draft: {
        symbol: TradingOrderDraft['symbol']
        side: TradingOrderDraft['side']
        type: string
        duration: string
        quantity: number
        cashQuantity?: number
      }
    }
    const timestamp = new Date().toISOString()
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        order: {
          ...requestBody.draft,
          id: 'cash-quantity-mapping-only',
          status: 'placing',
          submittedAt: timestamp,
          updatedAt: timestamp,
          remainingQuantity: 0,
        },
      }),
    })
  })

  const placementResponse = page.waitForResponse(
    (result) =>
      result.request().method() === 'POST' &&
      new URL(result.url()).pathname === '/api/v1/ibkr/orders',
  )
  await preview.getByRole('button', { name: 'Send Order', exact: true }).click()
  const placement = await placementResponse
  expect(placement.request().postDataJSON().draft).toMatchObject({
    type: 'market',
    duration: 'ioc',
    quantity: 0,
    cashQuantity: 25,
  })
  expect(placement.status()).toBe(201)
})
