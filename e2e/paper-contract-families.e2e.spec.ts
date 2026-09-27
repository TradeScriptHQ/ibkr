import type {
  BarHistoryResult,
  BrokerContractDetails,
  BrokerSymbol,
  MarketQuote,
  MarketSessionInfo,
  OrderDraft,
  OrderPreviewResult,
  PlaceOrderResult,
} from '@ibkr-terminal/contracts'
import type { APIRequestContext } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import { discover as discoverNative, select } from './support/instrument-contracts.js'
import {
  accepted,
  positionQuantities,
  readState,
  verifyMarketFill,
} from './support/paper-orders.js'
import {
  browserHeaders,
  expectJsonOk,
  openTerminalSession,
  type TerminalSession,
} from './support/session.js'

// Classification cases include the native SDK search, selection, ticket and reload.
const families = [
  {
    name: 'US Treasury bond',
    root: 'US-T',
    securityType: 'BOND',
    assetClass: 'bond',
    label: 'Bonds',
    exchange: 'SMART',
    currency: 'USD',
  },
  {
    name: 'listed warrant',
    root: 'GOOG',
    securityType: 'WAR',
    assetClass: 'warrant',
    label: 'Warrants',
    exchange: 'FWB',
    currency: 'EUR',
  },
  {
    name: 'spot gold',
    root: 'XAUUSD',
    securityType: 'CMDTY',
    assetClass: 'commodity',
    label: 'Spot metals / commodities',
    exchange: 'SMART',
    currency: 'USD',
  },
  {
    name: 'index CFD',
    root: 'IBUS500',
    securityType: 'CFD',
    assetClass: 'cfd',
    label: 'CFDs',
    exchange: 'SMART',
    currency: 'USD',
  },
]

async function discover(
  request: APIRequestContext,
  family: (typeof families)[number],
): Promise<BrokerContractDetails[]> {
  const params = new URLSearchParams({
    symbol: family.root,
    securityType: family.securityType,
    exchange: family.exchange,
    currency: family.currency,
  })
  if (family.assetClass === 'warrant') {
    // Qualify a future quarter from the broker catalog; never reuse an expired warrant ID.
    const now = new Date()
    const nextQuarter = new Date(
      Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 + 5, 1),
    )
    params.set(
      'expiry',
      `${nextQuarter.getUTCFullYear()}${String(nextQuarter.getUTCMonth() + 1).padStart(2, '0')}`,
    )
  }
  const rows = await expectJsonOk<BrokerContractDetails[]>(
    await request.get(`/api/v1/ibkr/contracts?${params}`, {
      headers: browserHeaders,
      timeout: 60_000,
    }),
  )
  expect(rows.length, `No ${family.name} contracts returned by TWS`).toBeGreaterThan(0)
  return rows
}
async function place(
  request: APIRequestContext,
  session: TerminalSession,
  draft: OrderDraft,
): Promise<string> {
  const body = { draft, expectedExecutionEnvironment: 'paper' }
  const preview = await expectJsonOk<OrderPreviewResult>(
    await request.post('/api/v1/ibkr/orders/preview', {
      headers: session.mutationHeaders,
      data: body,
    }),
  )
  expect(preview.accepted, preview.reason).toBe(true)
  const result = await expectJsonOk<PlaceOrderResult>(
    await request.post('/api/v1/ibkr/orders', {
      headers: session.mutationHeaders,
      data: { ...body, draft: { ...draft, confirmId: preview.confirmId } },
    }),
  )
  if (!result.order?.id) throw new Error('Missing test-owned order receipt')
  return result.order.id
}
async function cleanup(
  request: APIRequestContext,
  session: TerminalSession,
  id: string,
  symbol: BrokerSymbol,
) {
  const state = await readState(request)
  if (state.orders.some((order) => order.id === id)) {
    await expectJsonOk(
      await request.delete(`/api/v1/ibkr/orders/${id}`, {
        headers: session.mutationHeaders,
        data: { expectedExecutionEnvironment: 'paper' },
      }),
    )
    await expect
      .poll(async () => (await readState(request)).orders.some((order) => order.id === id), {
        timeout: 30_000,
      })
      .toBe(false)
  }
  const final = await readState(request)
  const record = final.ordersHistory?.find((order) => order.id === id)
  expect(record?.status).toMatch(/^(cancelled|filled|rejected|inactive)$/)
  if (record?.filledQuantity) {
    const closeId = await place(request, session, {
      symbol,
      accountId: record.accountId,
      side: record.side === 'buy' ? 'sell' : 'buy',
      type: 'market',
      duration: 'day',
      quantity: record.filledQuantity,
    })
    await verifyMarketFill(request, closeId)
  }
}

for (const family of families) {
  test(`${family.name}: native classification and exact-ID identity survive ticket selection and reload`, async ({
    request,
    page,
  }) => {
    test.setTimeout(180_000)
    await openTerminalSession(request)
    const rows = await discover(request, family)
    expect(new Set(rows.map((row) => row.symbol.contractIdentity?.conId)).size).toBe(rows.length)
    // A broad Treasury response includes matured issues. Use a broker-reported
    // future trading window instead of interpreting the bond's short-name text.
    const first =
      family.assetClass === 'bond'
        ? rows.find((row) => row.tradingWindows?.some((window) => window.closesAt > Date.now()))
        : rows[0]
    if (!first) throw new Error('No contract with a current broker trading schedule')
    expect(first.symbol.assetClass).toBe(family.assetClass)
    expect(first.symbol.contractIdentity?.securityType).toBe(family.securityType)
    const exact = await expectJsonOk<BrokerContractDetails[]>(
      await request.get(
        `/api/v1/ibkr/contracts?${new URLSearchParams({ symbol: family.root, securityType: family.securityType, exchange: family.exchange, conId: String(first.symbol.contractIdentity!.conId) })}`,
        { headers: browserHeaders },
      ),
    )
    expect(exact).toHaveLength(1)
    expect(exact[0]?.symbol.contractIdentity?.conId).toBe(first.symbol.contractIdentity?.conId)
    if (family.assetClass === 'bond') {
      expect(exact[0]?.bond?.cusip).toBeTruthy()
      expect(exact[0]?.minQuantity).toBeGreaterThan(0)
      expect(exact[0]?.quantityStep).toBeGreaterThan(0)
      const metadata = await expectJsonOk<MarketSessionInfo>(
        await request.get(
          `/api/v1/ibkr/sessions?${new URLSearchParams({ symbol: first.symbol.canonicalSymbol!, assetClass: 'bond', exchange: family.exchange })}`,
          { headers: browserHeaders },
        ),
      )
      expect(metadata.symbol.currency).toBe(exact[0]?.symbol.currency)
      expect(metadata.metadata).toMatchObject({
        minQuantity: exact[0]?.minQuantity,
        quantityStep: exact[0]?.quantityStep,
      })
    } else {
      expect(exact[0]?.symbol.currency).toBe(family.currency)
      expect(exact[0]?.minTick).toBeGreaterThan(0)
      expect(exact[0]?.minQuantity).toBeGreaterThan(0)
    }
    if (family.assetClass === 'warrant') {
      expect(exact[0]?.symbol.contractIdentity?.expiry).toMatch(/^\d{8}/)
      expect(exact[0]?.symbol.contractIdentity?.strike).toBeGreaterThan(0)
      expect(exact[0]?.symbol.contractIdentity?.right).toMatch(/^[CP]$/)
    }
    const canonical = `IBKR:${first.symbol.contractIdentity!.conId}`
    const native = (
      await discoverNative(request, canonical, family.assetClass, family.exchange)
    )[0]!
    expect(native.type).toBe(family.assetClass)
    if (family.assetClass === 'bond') {
      expect(native.name).toBe(exact[0]?.name)
      expect(native.name).toBeTruthy()
    }
    expect(native.brokerSymbol).toBe(canonical)
    expect(native.currency).toBe(exact[0]?.symbol.currency)
    await select(page, canonical, family.label, native)
    const readSelection = () =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('ibkr-terminal:last-instrument:v1') ?? '{}'),
      )
    const expected = {
      canonicalSymbol: canonical,
      brokerSymbol: canonical,
      type: family.assetClass,
      exchange: family.exchange,
    }
    await expect.poll(readSelection).toMatchObject(expected)
    const ticket = page.getByRole('region', { name: 'Order Entry' })
    await expect(ticket.getByText(native.ticker, { exact: true }).first()).toBeVisible()
    if (!native.currency) {
      await expect(
        page
          .getByText(
            'IBKR has not supplied the contract currency. Trading is unavailable until contract metadata is complete.',
            { exact: true },
          )
          .first(),
      ).toBeVisible()
    }
    if (family.assetClass === 'bond' && !native.currency) {
      await expect(
        ticket.getByRole('button', { name: new RegExp(`Buy ${native.ticker}`) }),
      ).toBeDisabled()
    }
    await page.reload()
    await expect(page.getByRole('button', { name: /^Change symbol / })).toContainText(
      native.name ?? native.ticker,
      { timeout: 60_000 },
    )
    await expect.poll(readSelection).toMatchObject(expected)
    await expect(ticket.getByText(native.ticker, { exact: true }).first()).toBeVisible()
    if (family.assetClass === 'cfd' || family.assetClass === 'commodity') {
      const history = await expectJsonOk<BarHistoryResult>(
        await request.get(
          `/api/v1/ibkr/bars?${new URLSearchParams({ symbol: first.symbol.canonicalSymbol!, assetClass: family.assetClass, exchange: family.exchange, currency: family.currency, interval: '1D', barCount: '5' })}`,
          { headers: browserHeaders },
        ),
      )
      expect(history.dataUnavailable).toBe(false)
      expect(history.bars.length).toBeGreaterThan(0)
      for (const bar of history.bars) {
        expect(bar.close).toBeGreaterThan(0)
        // IBKR midpoint history has no traded-volume field.
        expect(bar).not.toHaveProperty('volume')
      }
    }
  })
  for (const flow of ['lifecycle', 'execution'] as const) {
    test(`${family.name}: broker paper ${flow} and owned-fill cleanup @paper`, async ({
      request,
    }) => {
      test.setTimeout(180_000)
      const session = await openTerminalSession(request)
      const rows = await discover(request, family)
      const selected = rows.find(
        (row) =>
          row.symbol.currency &&
          row.minQuantity &&
          row.quantityStep &&
          row.minTick &&
          row.tradingWindows?.length,
      )
      test.skip(
        !selected,
        'TWS returned no contract with currency, sizing increments and a trading calendar; execution remains unqualified',
      )
      if (!selected) throw new Error('No qualified contract')
      test.skip(
        !selected.tradingWindows?.some(
          (window) => window.opensAt <= Date.now() && window.closesAt > Date.now(),
        ),
        'TWS contract schedule is closed; placement, modification and fill cleanup require an open venue',
      )
      const symbol = { ...selected.symbol, symbol: selected.symbol.canonicalSymbol! }
      let quote: MarketQuote | undefined
      if (flow === 'lifecycle') {
        await expect
          .poll(
            async () => {
              const params = new URLSearchParams({
                symbol: symbol.symbol,
                exchange: family.exchange,
                currency: symbol.currency!,
                assetClass: family.assetClass,
              })
              quote = (
                await expectJsonOk<MarketQuote[]>(
                  await request.get(`/api/v1/ibkr/quotes?fresh=true&${params}`, {
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
      }
      const tick = selected.minTick!
      const reference = quote?.bid ?? quote?.previousClose
      if (flow === 'lifecycle' && !reference) throw new Error('Broker reference price missing')
      const price = Number(
        (Math.max(2, Math.floor((Number(reference) * 0.98) / tick)) * tick).toFixed(8),
      )
      const baseline = positionQuantities(await readState(request))
      const draft: OrderDraft = {
        symbol,
        side: 'buy',
        type: flow === 'execution' ? 'market' : 'limit',
        quantity: selected.minQuantity!,
        duration: 'day',
        ...(flow === 'execution' ? {} : { limitPrice: price }),
      }
      let id: string | undefined
      try {
        id = await place(request, session, draft)
        const family = await accepted(request, id, 1)
        expect(family[0]?.symbol.contractIdentity?.conId).toBe(
          selected.symbol.contractIdentity?.conId,
        )
        if (flow === 'execution') await verifyMarketFill(request, id)
        else {
          const nextPrice = Number((price - tick).toFixed(8))
          const previous = new Set((await readState(request)).diagnostics.map((item) => item.id))
          await expectJsonOk(
            await request.patch(`/api/v1/ibkr/orders/${id}`, {
              headers: session.mutationHeaders,
              data: { patch: { limitPrice: nextPrice }, expectedExecutionEnvironment: 'paper' },
            }),
          )
          await expect
            .poll(
              async () => {
                const state = await readState(request)
                return (
                  state.orders.some((order) => order.id === id && order.limitPrice === nextPrice) &&
                  state.diagnostics.some(
                    (item) =>
                      !previous.has(item.id) &&
                      item.text.includes(`IBKR raw openOrder orderId=${id} `),
                  )
                )
              },
              { timeout: 30_000 },
            )
            .toBe(true)
        }
      } finally {
        if (id) await cleanup(request, session, id, symbol)
        await expect
          .poll(async () => positionQuantities(await readState(request)), { timeout: 30_000 })
          .toEqual(baseline)
      }
    })
  }
}
