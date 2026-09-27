import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter'

afterEach(() => vi.unstubAllGlobals())

it.each(['place', 'modify'])(
  'preserves the broker units for a %s preview without counting commission twice',
  async (operation) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accepted: true,
            estimatedCommission: 1,
            commissionCurrency: 'USD',
            estimatedMargin: 10,
            marginCurrency: 'EUR',
            estimatedCost: 200,
            estimatedCostSource: 'broker',
            estimatedCostCurrency: 'USD',
          }),
        ),
      ),
    )
    const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
    if (!broker.previewOrder || !broker.previewModifyOrder)
      throw new Error('Order previews are required')
    const symbol = { ticker: 'AAPL', exchange: 'SMART', type: 'stock' as const, currency: 'USD' }
    const context = { symbol, accountId: 'DU123', currency: 'EUR' }
    const preview =
      operation === 'place'
        ? await broker.previewOrder(
            { symbol, side: 'buy', type: 'limit', quantity: 1, price: 200 },
            context,
          )
        : await broker.previewModifyOrder('123', { price: 200 }, context)
    expect(preview).toMatchObject({
      estimatedCommission: 1,
      commissionCurrency: 'USD',
      estimatedMargin: 10,
      marginCurrency: 'EUR',
    })
    expect(preview.estimatedFees).toBeUndefined()
    expect(preview.sections?.[0]?.rows?.[0]?.value).toBe('$200.00')
  },
)

it('labels alternative exit commissions while keeping entry commission and broker currencies separate', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: true,
          estimatedCommission: 1,
          commissionCurrency: 'USD',
          exitCommissions: [
            {
              levelId: 'a',
              leg: 'take-profit',
              quantity: 1,
              estimatedCommission: 2,
              commissionCurrency: 'USD',
            },
            { levelId: 'a', leg: 'stop-loss', quantity: 1, reason: 'IBKR estimate unavailable' },
            {
              levelId: 'b',
              leg: 'take-profit',
              quantity: 2,
              estimatedCommission: 0,
              commissionCurrency: 'EUR',
            },
            { levelId: 'b', leg: 'stop-loss', quantity: 2, estimatedCommission: 3 },
          ],
          warnings: ['Stop loss commission unavailable: IBKR estimate unavailable'],
        }),
      ),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  if (!broker.previewOrder) throw new Error('Preview required')
  const symbol = { ticker: 'AAPL', type: 'stock' as const, currency: 'USD' }
  const result = await broker.previewOrder(
    { symbol, side: 'buy', type: 'limit', quantity: 3, price: 300 },
    { symbol, accountId: 'DU123' },
  )
  expect(result.estimatedCommission).toBe(1)
  expect(result.estimatedFees).toBeUndefined()
  expect(result.sections).toEqual([
    {
      title: 'Potential exit commission · TP / SL are alternatives',
      rows: [
        { label: 'Level 1 · Take profit (1)', value: '$2.00' },
        { label: 'Level 1 · Stop loss (1)', value: 'Unavailable' },
        { label: 'Level 2 · Take profit (2)', value: '€0.00' },
        { label: 'Level 2 · Stop loss (2)', value: '3 (currency unavailable)' },
      ],
    },
  ])
  expect(result.warnings?.[0]).toContain('IBKR estimate unavailable')
})

it('carries commission bounds into the SDK preview contract', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        accepted: true,
        estimatedCommissionRange: { minimum: 0.35, maximum: 1 },
        commissionCurrency: 'USD',
      }),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  if (!broker.previewOrder) throw new Error('Preview required')
  const symbol = { ticker: 'AAPL', type: 'stock' as const, currency: 'USD' }

  expect(
    await broker.previewOrder(
      { symbol, side: 'buy', type: 'market', quantity: 1 },
      { symbol, accountId: 'DU123' },
    ),
  ).toMatchObject({
    estimatedCommissionRange: { minimum: 0.35, maximum: 1 },
    commissionCurrency: 'USD',
  })
})

it('asks the gateway to preview a position close and preserves its rejection', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ accepted: false, reason: 'Opposing outcome quote is unavailable.' }),
    )
  vi.stubGlobal('fetch', fetch)
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  if (!broker.previewClosePosition) throw new Error('Position close preview is required')
  const context = {
    symbol: { ticker: 'FF', type: 'event-contract' as const, currency: 'USD' },
    accountId: 'DU123',
  }
  expect(await broker.previewClosePosition('position-test', context)).toMatchObject({
    accepted: false,
    message: 'Opposing outcome quote is unavailable.',
  })
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining('/positions/position-test/close/preview'),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ context, expectedExecutionEnvironment: 'paper' }),
    }),
  )
})
