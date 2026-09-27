import type { MarketQuote, MarketSessionInfo } from '@ibkr-terminal/contracts'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import { expect, test } from './support/fixtures.js'
import { descriptor, discover, queryFor, select } from './support/instrument-contracts.js'
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

test.beforeEach(async ({ request }) => {
  await openTerminalSession(request)
})

test('micro futures: exact expiry, multiplier and native selection survive reload', async ({
  page,
  request,
}) => {
  const rows = await discover(request, 'MES', 'futures', 'CME')
  expect(new Set(rows.map((row) => row.canonicalSymbol)).size).toBe(rows.length)
  expect(rows.length).toBeGreaterThan(1)
  const selected = rows[1]!
  expect(selected.contractMultiplier).toBe(5)
  expect(selected.contractIdentity?.expiry).toMatch(/^\d{8}/)
  const symbol = descriptor(selected)
  const session = await expectJsonOk<MarketSessionInfo>(
    await request.get(`/api/v1/ibkr/sessions?${queryFor(symbol)}`, { headers: browserHeaders }),
  )
  expect(session.symbol.canonicalSymbol).toBe(selected.canonicalSymbol)
  expect(session.metadata?.contractMultiplier).toBe(5)
  await select(page, 'MES', 'Futures', selected)
  await expect(
    page
      .getByRole('region', { name: 'Order Entry' })
      .getByRole('button', { name: 'LMT', exact: true }),
  ).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: /^Change symbol / })).toContainText(
    selected.ticker,
    { timeout: 60_000 },
  )
})

test('cash index: native selection provides reference data and prevents order entry', async ({
  page,
  request,
}) => {
  const selected = (await discover(request, 'SPX', 'index', 'CBOE'))[0]!
  expect(selected.contractIdentity?.securityType).toBe('IND')
  await select(page, 'SPX', 'Indices', selected)
  await expect(
    page
      .getByText('Cash indices are reference data. Select an index option or future to trade.', {
        exact: true,
      })
      .first(),
  ).toBeVisible()
})

// MBT provides a weekend-open micro-futures path; retain MES for equity-index qualification.
for (const root of ['MES', 'MBT'] as const) {
  for (const flow of ['lifecycle', 'execution'] as const) {
    test(`${root} micro futures: paper ${flow} preserves exact contract and reconciles cleanup @paper`, async ({
      page,
      request,
    }) => {
      test.setTimeout(240_000)
      const rows = await discover(request, root, 'futures', 'CME')
      const selected = rows.find((row) => {
        const expiry = row.contractIdentity?.expiry?.slice(0, 8)
        return expiry && expiry >= new Date().toISOString().slice(0, 10).replaceAll('-', '')
      })
      if (!selected) throw new Error(`TWS returned no unexpired ${root} contract`)
      const symbol = descriptor(selected)
      const outstanding = (await readState(request)).orders.filter(
        (order) => order.symbol.contractIdentity?.conId === selected.contractIdentity?.conId,
      )
      expect(
        outstanding.map((order) => order.id),
        `${root} has unsettled broker orders; reconcile them before another lifecycle run`,
      ).toEqual([])
      const session = await expectJsonOk<MarketSessionInfo>(
        await request.get(`/api/v1/ibkr/sessions?${queryFor(symbol)}`, { headers: browserHeaders }),
      )
      test.skip(
        !session.upcoming.some(
          (window) =>
            window.opensAt <= Date.now() &&
            window.closesAt > Date.now() &&
            ['regular', 'pre-market', 'post-market', 'extended'].includes(window.state),
        ),
        `IBKR session is ${session.currentState}; futures order verification requires an open venue`,
      )
      let quote: MarketQuote | undefined
      if (flow === 'lifecycle') {
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
              return Boolean(quote?.ibkrErrorCode || quote?.bid || quote?.previousClose)
            },
            { timeout: 45_000 },
          )
          .toBe(true)
        test.skip(
          [354, 10089, 10167].includes(quote?.ibkrErrorCode ?? 0),
          `IBKR quote restriction: ${quote?.unavailableReason}`,
        )
        expect(['ok', 'delayed']).toContain(quote?.status)
        test.info().annotations.push({
          type: 'IBKR reference data',
          description: `${root}: ${quote?.status}; only used to keep the lifecycle limit away from the market`,
        })
      }
      const tick = selected.minTick
      const reference = quote?.bid ?? quote?.previousClose
      if (!tick || (flow === 'lifecycle' && !reference))
        throw new Error('Broker price increment or reference quote missing')
      await select(page, selected.canonicalSymbol!, 'Futures', selected)
      const baseline = positionQuantities(await readState(request))
      const ids: string[] = []
      let draft: TradingOrderDraft | undefined
      try {
        const price = Math.floor((Number(reference) * 0.995) / tick) * tick
        draft = {
          symbol,
          side: 'buy',
          type: flow === 'execution' ? 'market' : 'limit',
          duration: { type: 'day' },
          quantity: 1,
          ...(flow === 'execution' ? {} : { price }),
        }
        const id = await submit(page, draft)
        ids.push(id)
        const family = await accepted(request, id, 1)
        expect(family[0]?.symbol.contractIdentity?.conId).toBe(selected.contractIdentity?.conId)
        if (flow === 'execution') await verifyMarketFill(request, id)
        else await modifyLimit(page, request, id, price - tick, symbol)
      } finally {
        for (const id of ids) await cleanUp(page, request, id, draft)
        await expect
          .poll(async () => positionQuantities(await readState(request)), { timeout: 30_000 })
          .toEqual(baseline)
      }
    })
  }
}

test('mutual fund: native discovery preserves identity and explains the IBKR paper restriction', async ({
  page,
  request,
}) => {
  const selected = (await discover(request, 'VINIX', 'fund', 'FUNDSERV'))[0]!
  expect(selected.contractIdentity?.securityType).toBe('FUND')
  await select(page, 'VINIX', 'Mutual funds', selected)
  await expect(
    page
      .getByText('IBKR does not support mutual fund trading in paper accounts.', { exact: true })
      .first(),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Order Entry' }).getByRole('button', { name: /Buy VINIX/ }),
  ).toBeDisabled()
})
