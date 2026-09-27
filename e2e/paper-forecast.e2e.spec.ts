import type { BrokerSymbol, MarketQuote, MarketSessionInfo } from '@ibkr-terminal/contracts'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import { expect, test } from './support/fixtures.js'
import { descriptor, discover, queryFor, select } from './support/instrument-contracts.js'
import {
  accepted,
  cleanUp,
  modifyLimit,
  positionQuantities,
  readState,
  verifyMarketFill,
} from './support/paper-orders.js'
import { browserHeaders, expectJsonOk, openTerminalSession } from './support/session.js'

function forecastSearch(): string {
  const now = new Date()
  return `FF ${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

test.beforeEach(async ({ request }) => {
  await openTerminalSession(request)
})

test('ForecastEx: native outcome identity and its exact opposing contract', async ({
  page,
  request,
}) => {
  const selected = (await discover(request, forecastSearch(), 'event-contract', 'FORECASTX'))[0]!
  expect(selected.contractIdentity).toMatchObject({ securityType: 'OPT', multiplier: 1 })
  const opposite = await expectJsonOk<BrokerSymbol>(
    await request.get(`/api/v1/ibkr/contracts/opposing-outcome?${queryFor(descriptor(selected))}`, {
      headers: browserHeaders,
    }),
  )
  expect(opposite.contractIdentity?.conId).not.toBe(selected.contractIdentity?.conId)
  expect(opposite.contractIdentity?.expiry).toBe(selected.contractIdentity?.expiry)
  expect(opposite.contractIdentity?.strike).toBe(selected.contractIdentity?.strike)
  expect(opposite.contractIdentity?.right).toBe(
    selected.contractIdentity?.right === 'C' ? 'P' : 'C',
  )
  await select(page, forecastSearch(), 'Forecast contracts', selected)
  const ticket = page.getByRole('region', { name: 'Order Entry' })
  await expect(ticket.getByText('Prediction Market', { exact: true })).toBeVisible()
  await expect(ticket.getByText('LMT', { exact: true })).toBeVisible()
  await expect(ticket.getByRole('button', { name: 'MKT', exact: true })).toHaveCount(0)
  await expect(ticket.getByRole('button', { name: 'Sell', exact: true })).toBeDisabled()
  const oppositeLabel = selected.contractIdentity?.right === 'C' ? 'No' : 'Yes'
  await ticket.getByRole('button', { name: new RegExp(`^${oppositeLabel},`) }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('ibkr-terminal:last-instrument:v1') ?? '{}')
            .canonicalSymbol,
      ),
    )
    .toBe(`IBKR:${opposite.contractIdentity?.conId}`)
  await page.reload()
  await expect(ticket.getByText('Prediction Market', { exact: true })).toBeVisible()
  await expect(
    ticket.getByRole('button', { name: new RegExp(`^${oppositeLabel},`) }),
  ).toHaveAttribute('aria-pressed', 'true')
})

for (const flow of ['lifecycle', 'execution'] as const) {
  test(`ForecastEx: paper ${flow} and opposing-outcome fill cleanup @paper`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const selected = (await discover(request, forecastSearch(), 'event-contract', 'FORECASTX'))[0]!
    const symbol = descriptor(selected)
    const session = await expectJsonOk<MarketSessionInfo>(
      await request.get(`/api/v1/ibkr/sessions?${queryFor(symbol)}`, { headers: browserHeaders }),
    )
    test.skip(
      !session.upcoming.some(
        (window) =>
          window.opensAt <= Date.now() &&
          window.closesAt > Date.now() &&
          ['regular', 'extended'].includes(window.state),
      ),
      `TWS ForecastEx session is ${session.currentState}`,
    )
    await select(page, forecastSearch(), 'Forecast contracts', selected)
    let quote: MarketQuote | undefined
    await expect
      .poll(
        async () => {
          quote = (
            await expectJsonOk<MarketQuote[]>(
              await request.get(`/api/v1/ibkr/quotes?fresh=true&${queryFor(symbol)}`, {
                headers: browserHeaders,
              }),
            )
          )[0]
          return Boolean(quote?.ibkrErrorCode || (quote?.bid && quote?.ask))
        },
        { timeout: 45_000 },
      )
      .toBe(true)
    test.skip(
      [354, 10089, 10167].includes(quote?.ibkrErrorCode ?? 0),
      `IBKR quote restriction: ${quote?.unavailableReason}`,
    )
    expect(flow === 'execution' ? ['ok'] : ['ok', 'delayed']).toContain(quote?.status)
    if (flow === 'execution') {
      expect(Date.now() - Date.parse(quote!.timestamp)).toBeLessThan(30_000)
    } else {
      test.info().annotations.push({
        type: 'IBKR reference data',
        description: `ForecastEx: ${quote?.status}; only used to keep the lifecycle limit away from the market`,
      })
    }
    const price =
      flow === 'execution' ? quote!.ask! : Math.max(0.02, Number((quote!.bid! - 0.02).toFixed(2)))
    const draft: TradingOrderDraft = {
      symbol,
      side: 'buy',
      type: 'limit',
      duration: { type: 'day' },
      quantity: 1,
      price,
    }
    const baseline = positionQuantities(await readState(request))
    let id: string | undefined
    const closingOrderIds: string[] = []
    try {
      const ticket = page.getByRole('region', { name: 'Order Entry', exact: true })
      await expect(ticket.getByText('Prediction Market', { exact: true })).toBeVisible()
      await ticket.getByRole('textbox', { name: 'Shares', exact: true }).fill('1')
      await ticket.getByRole('textbox', { name: 'Limit price', exact: true }).fill(String(price))
      await ticket.getByRole('button', { name: 'Review Buy', exact: true }).click()
      const placedResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/ibkr/orders',
      )
      await ticket.getByRole('button', { name: 'Place Buy', exact: true }).click()
      const response = await placedResponse
      expect(response.ok()).toBe(true)
      const placement: { order?: { id: string } } = await response.json()
      id = placement.order?.id
      if (!id) throw new Error('Prediction ticket placement omitted the order receipt')
      const orders = await accepted(request, id, 1)
      expect(orders[0]?.symbol.contractIdentity?.conId).toBe(selected.contractIdentity?.conId)
      if (flow === 'execution') {
        await verifyMarketFill(request, id)
        await expect
          .poll(async () =>
            (await readState(request)).positions.some(
              (position) =>
                position.symbol.contractIdentity?.conId === selected.contractIdentity?.conId &&
                position.quantity >= 1 &&
                position.symbol.assetClass === 'event-contract',
            ),
          )
          .toBe(true)
        const response = page
          .waitForResponse(
            (response) =>
              response.request().method() === 'POST' &&
              /\/positions\/[^/]+\/close$/.test(new URL(response.url()).pathname),
          )
          .then(async (response) => {
            expect(response.status()).toBe(201)
            const result = await response.json()
            if (typeof result.order?.id !== 'string')
              throw new Error('Position close returned no receipt')
            closingOrderIds.push(result.order.id)
            return result.order.id as string
          })
        const [closeId] = await Promise.all([
          response,
          page.evaluate(
            async ({ conId }) => {
              const driver = window.__ibkrChartTradingE2E__
              if (!driver) throw new Error('The native SDK test driver is unavailable')
              const trading = await driver.getPaperTradingController()
              const state = await trading.getState()
              const position = state.positions.find(
                (position) => position.symbol.brokerSymbol === `IBKR:${conId}`,
              )
              if (
                !position ||
                position.quantity < 1 ||
                position.symbol.type !== 'event-contract' ||
                position.symbol.currency !== 'USD'
              )
                throw new Error('Exact ForecastEx position has not reached the SDK')
              const context = {
                symbol: position.symbol,
                accountId: position.accountId,
                currency: position.symbol.currency,
              }
              const preview = await trading.previewClosePosition(position.id, context)
              if (!preview.accepted)
                throw new Error(preview.message ?? 'Position close preview rejected')
              await trading.closePosition(position.id, context, { quantity: 1 })
            },
            { conId: selected.contractIdentity!.conId },
          ),
        ])
        await verifyMarketFill(request, closeId)
      } else await modifyLimit(page, request, id, Number((price - 0.01).toFixed(2)), symbol)
    } finally {
      if (id) await cleanUp(page, request, id, draft, closingOrderIds)
      await expect
        .poll(async () => positionQuantities(await readState(request)), { timeout: 30_000 })
        .toEqual(baseline)
    }
  })
}
