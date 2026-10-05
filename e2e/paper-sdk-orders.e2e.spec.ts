import type { OptionChainResult } from '@ibkr-terminal/contracts'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import { expect, test } from './support/fixtures.js'
import { readExplicitOptionCatalog, toNativeSdkOptionContract } from './support/option-catalog.js'
import {
  accepted,
  cleanUp,
  modifyLimit,
  positionQuantities,
  readState,
  requireRegularSession,
  showOrderFamilyOnChart,
  stockReference,
  submit,
  symbol,
  verifyMarketFill,
} from './support/paper-orders.js'
import { browserHeaders, expectJsonOk, openTerminalSession } from './support/session.js'

test.describe('paper TWS through the mounted SDK @paper', () => {
  test.beforeEach(async ({ page, request }) => {
    await openTerminalSession(request)
    await page.goto('/')
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-trading-operation-support',
      /placeOrder/,
      { timeout: 45_000 },
    )
  })

  for (const side of ['buy', 'sell'] as const) {
    for (const type of ['limit', 'market', 'stop', 'stop-limit', 'bracket'] as const) {
      if (side === 'sell' && type !== 'limit') continue
      test(`stock ${side} ${type}: SDK submission, sustained acceptance and cleanup`, async ({
        page,
        request,
      }) => {
        test.setTimeout(120_000)
        if (type === 'market') await requireRegularSession(request)
        const reference = await stockReference(request)
        const price = Number((reference! * (side === 'buy' ? 0.98 : 1.02)).toFixed(2))
        const stopPrice = Number((reference! * (side === 'buy' ? 1.02 : 0.98)).toFixed(2))
        const draft: TradingOrderDraft = {
          symbol,
          side,
          type: type === 'bracket' ? 'limit' : type,
          quantity: type === 'bracket' ? 2 : 1,
          duration: { type: 'day' },
          ...(['limit', 'bracket', 'stop-limit'].includes(type)
            ? {
                price:
                  type === 'stop-limit'
                    ? Number((stopPrice * (side === 'buy' ? 1.001 : 0.999)).toFixed(2))
                    : price,
              }
            : {}),
          ...(['stop', 'stop-limit'].includes(type) ? { stopPrice } : {}),
          ...(type === 'bracket'
            ? {
                exits: {
                  levels: [0, 1].map((index) => ({
                    id: `e2e-exit-${index}`,
                    quantity: 1,
                    takeProfit: { price: Number((price * (1.03 + index * 0.01)).toFixed(2)) },
                    stopLoss: {
                      kind: 'fixed' as const,
                      triggerPrice: Number((price * (0.97 - index * 0.01)).toFixed(2)),
                    },
                  })),
                },
              }
            : {}),
          customFields: { qualification: `sdk-paper-${Date.now()}-${side}-${type}` },
        }
        const baseline = positionQuantities(await readState(request))
        let id: string | undefined
        try {
          id = await submit(page, draft)
          const family = await accepted(request, id, type === 'bracket' ? 5 : 1)
          if (type === 'bracket') {
            expect(family.filter((order) => order.parentId === id)).toHaveLength(4)
            await showOrderFamilyOnChart(page, family)
          }
          if (type === 'market') await verifyMarketFill(request, id)
          if (type === 'limit')
            await modifyLimit(
              page,
              request,
              id,
              Number((price + (side === 'buy' ? -0.01 : 0.01)).toFixed(2)),
            )
        } finally {
          if (id) await cleanUp(page, request, id, draft)
          await expect
            .poll(async () => positionQuantities(await readState(request)), { timeout: 30_000 })
            .toEqual(baseline)
        }
      })
    }
  }
  for (const right of ['call', 'put'] as const) {
    for (const side of ['buy', 'sell'] as const) {
      for (const type of ['limit', 'market', 'vertical'] as const) {
        if (right === 'put' && (side !== 'buy' || type !== 'limit')) continue
        if (type === 'market' && side !== 'buy') continue
        test(`option ${right} ${side} ${type}: SDK acceptance and cleanup`, async ({
          page,
          request,
        }) => {
          test.setTimeout(180_000)
          if (type === 'market') await requireRegularSession(request)
          const reference = await stockReference(request)
          const query = new URLSearchParams({
            underlying: 'AAPL',
            exchange: 'SMART',
            currency: 'USD',
            centerPrice: String(reference),
            maxQuoteContracts: '2',
          })
          const { selection } = await readExplicitOptionCatalog(request, query, {
            notBefore: Date.now() + 4 * 86400_000,
          })
          query.set('tradingClass', selection.tradingClass)
          query.set('expiration', selection.expiration)
          query.set('quoteWindowRows', '8')
          query.set('maxQuoteContracts', '16')
          test.info().annotations.push({
            type: 'option-api-boundary',
            description:
              'Programmatic SDK draft preserves a provider-qualified native ID and tuple; installed SDK widget class selection/rendering remains unqualified under H13.',
          })
          let entries: OptionChainResult['expirations'][number]['contracts'] = []
          await expect
            .poll(
              async () => {
                const chain = await expectJsonOk<OptionChainResult>(
                  await request.get(`/api/v1/ibkr/options/chain?${query}`, {
                    headers: browserHeaders,
                    timeout: 90_000,
                  }),
                )
                entries = chain.expirations
                  .flatMap((e) => e.contracts)
                  .filter(
                    (e) =>
                      e.contract.right === right &&
                      e.contract.brokerContractId &&
                      e.bid! > 0 &&
                      e.ask! > 0,
                  )
                  .sort((a, b) => a.contract.strike - b.contract.strike)
                return entries.length
              },
              { timeout: 45_000, intervals: [1000, 1000, 2000] },
            )
            .toBeGreaterThanOrEqual(2)
          const first = entries[0]!
          const second = entries[1]!
          const primary = type === 'vertical' && right === 'put' ? second : first
          const other = primary === first ? second : first
          const mid = (entry: typeof first) => (entry.bid! + entry.ask!) / 2
          const price =
            type === 'vertical'
              ? Math.max(0.01, Math.round(Math.abs(mid(primary) - mid(other)) * 100) / 100)
              : Math.round((side === 'buy' ? primary.bid! * 0.95 : primary.ask! * 1.05) * 100) / 100
          const draft: TradingOrderDraft = {
            symbol,
            side,
            type: type === 'market' ? 'market' : 'limit',
            quantity: 1,
            duration: { type: 'day' },
            ...(type === 'market' ? {} : { price }),
            optionLegs: [
              {
                contract: toNativeSdkOptionContract(primary, symbol),
                side,
                positionEffect: 'open',
                quantity: 1,
                ratio: 1,
                price: mid(primary),
              },
              ...(type === 'vertical'
                ? [
                    {
                      contract: toNativeSdkOptionContract(other, symbol),
                      side: side === 'buy' ? ('sell' as const) : ('buy' as const),
                      positionEffect: 'open' as const,
                      quantity: 1,
                      ratio: 1,
                      price: mid(other),
                    },
                  ]
                : []),
            ],
            customFields: {
              qualification: `sdk-paper-option-${Date.now()}-${right}-${side}-${type}`,
            },
          }
          const baseline = positionQuantities(await readState(request))
          let id: string | undefined
          try {
            id = await submit(page, draft)
            await accepted(request, id, 1)
            if (type === 'market') await verifyMarketFill(request, id)
            if (type === 'limit') {
              const step = primary.contract.priceStep ?? 0.01
              const next = Math.max(
                step,
                Math.round((price + (side === 'buy' ? -step : step)) / step) * step,
              )
              await modifyLimit(page, request, id, Number(next.toFixed(4)))
            }
          } finally {
            if (id) await cleanUp(page, request, id, draft)
            await expect
              .poll(async () => positionQuantities(await readState(request)), { timeout: 30_000 })
              .toEqual(baseline)
          }
        })
      }
    }
  }
})
