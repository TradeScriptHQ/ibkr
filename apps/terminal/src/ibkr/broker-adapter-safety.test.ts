import type { TradingOrderContext, TradingOrderDraft } from '@tradescript/pro/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { toTradingState } from './broker-mapping.js'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter.js'
import type { BackendOrder, BackendState } from './types.js'
import { toBackendDraft } from './types.js'

const symbol = { ticker: 'TEST', currency: 'USD', type: 'stock' as const, exchange: 'SMART' }
const context: TradingOrderContext = { symbol }
const order: BackendOrder = {
  id: 'test-order',
  symbol: { symbol: 'TEST', currency: 'USD', assetClass: 'stock' },
  side: 'buy',
  type: 'limit',
  duration: 'day',
  quantity: 1,
  status: 'working',
  submittedAt: '2026-09-30T10:00:00Z',
  updatedAt: '2026-09-30T10:00:00Z',
}
const state = (orders: BackendOrder[] = []): BackendState => ({
  connectionStatus: 'connected',
  accounts: [{ id: 'test-account', label: 'Synthetic account', currency: 'USD' }],
  orders,
  ordersHistory: orders,
  positions: [],
  executions: [],
  quotes: [],
  messages: [],
  diagnostics: [],
  updatedAt: '2026-09-30T10:00:00Z',
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it.each(['index', 'futures'] as const)(
  'preserves an exact %s underlying through draft and leg serialization',
  (type) => {
    const underlying = {
      ticker: 'DISPLAY',
      brokerSymbol: 'IBKR:123',
      canonicalSymbol: 'IBKR:123',
      currency: 'USD',
      type,
      exchange: 'SMART',
    }
    const draft: TradingOrderDraft = {
      symbol: underlying,
      side: 'buy',
      type: 'limit',
      quantity: 1,
      price: 2,
      optionLegs: [
        {
          contract: {
            underlying: 'DISPLAY',
            underlyingSymbolInfo: underlying,
            expiration: '2026-10-16',
            strike: 200,
            right: 'call',
            multiplier: 100,
          },
          side: 'buy',
          positionEffect: 'open',
          quantity: 1,
          ratio: 1,
        },
      ],
    }
    const mapped = toBackendDraft(draft)
    expect(mapped.symbol).toMatchObject({ symbol: 'IBKR:123', canonicalSymbol: 'IBKR:123' })
    expect(mapped.optionLegs?.[0]?.contract.underlyingSymbolInfo).toMatchObject({
      symbol: 'IBKR:123',
      canonicalSymbol: 'IBKR:123',
      assetClass: type,
    })
  },
)

it('supports detached account and history callbacks used by the published SDK', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(state([order]))),
  )
  const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const listAccounts = adapter.listAccounts
  const getHistory = adapter.getOrdersHistory
  const accounts = await listAccounts?.()
  expect(accounts).toHaveLength(1)
  expect(accounts?.[0]?.capabilities?.supportsTrailingStop).toBe(false)
  expect(accounts?.[0]?.capabilities?.supportedOrderTypes).toContain('trailing-stop')
  expect(await getHistory?.()).toMatchObject([{ id: order.id }])
})

it('supports detached account-value subscriptions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...state(),
        accounts: [{ ...state().accounts[0], netLiquidation: 123, availableFunds: 90 }],
      }),
    ),
  )
  const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const subscribeEquity = adapter.subscribeEquity
  const subscribeMargin = adapter.subscribeMarginAvailable
  const equity = vi.fn()
  const margin = vi.fn()
  const stopEquity = subscribeEquity?.({}, equity)
  const stopMargin = subscribeMargin?.({ symbol }, margin)
  await vi.waitFor(() => {
    expect(equity).toHaveBeenCalledWith(123)
    expect(margin).toHaveBeenCalledWith(90)
  })
  stopEquity?.()
  stopMargin?.()
})

it('settles cancellation only after the matching broker acknowledgement', async () => {
  vi.useFakeTimers()
  let status: BackendOrder['status'] = 'working'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) =>
      Response.json(init?.method === 'DELETE' ? { ok: true } : state([{ ...order, status }])),
    ),
  )
  const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  let completed = false
  const pending = adapter.cancelOrder?.(order.id, context).then(() => {
    completed = true
  })
  await vi.advanceTimersByTimeAsync(1)
  expect(completed).toBe(false)
  status = 'cancelled'
  await vi.advanceTimersByTimeAsync(300)
  await pending
  expect(completed).toBe(true)
})

it.each(['filled', 'rejected'] as const)(
  'does not confirm cancellation when broker status is %s',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        Response.json(init?.method === 'DELETE' ? { ok: true } : state([{ ...order, status }])),
      ),
    )
    const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
    await expect(adapter.cancelOrder?.(order.id, context)).rejects.toMatchObject({
      code: 'CANCEL_NOT_CONFIRMED',
    })
  },
)

it('surfaces an unknown cancellation outcome when acknowledgement remains absent', async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => Response.json(init?.method === 'DELETE' ? { ok: true } : state())),
  )
  const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const pending = adapter.cancelOrder?.(order.id, context).catch((error) => error)
  await vi.advanceTimersByTimeAsync(10_001)
  expect(await pending).toMatchObject({ code: 'CANCEL_OUTCOME_UNKNOWN' })
})

it('preserves provider warnings and monetary facts in a position-close confirmation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        accepted: true,
        warnings: ['Provider warning'],
        estimatedCommission: 1.2,
        commissionCurrency: 'USD',
        estimatedFees: 0.5,
        feesCurrency: 'EUR',
        estimatedMargin: 10,
        marginCurrency: 'EUR',
      }),
    ),
  )
  const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const preview = await adapter.previewClosePosition?.('test-position', context)
  expect(preview?.message).toContain('Provider warning')
  const rows = preview?.sections?.flatMap((section) => section.rows)
  expect(rows).toEqual(
    expect.arrayContaining([
      { label: 'Estimated commission', value: '$1.20' },
      { label: 'Estimated fees', value: '€0.50' },
      { label: 'Estimated margin', value: '€10.00' },
    ]),
  )
})

it.each([undefined, Number.NaN])(
  'preserves full provider rules without a finite reference price',
  async (lastPrice) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          symbol: {
            minTick: 0.05,
            priceIncrements: [
              { lowEdge: 0, increment: 0.001 },
              { lowEdge: 10, increment: 0.05 },
            ],
          },
          metadata: {},
        }),
      ),
    )
    const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
    const info = await adapter.getTradingSymbolInfo?.({
      ...context,
      ...(lastPrice === undefined ? {} : { lastPrice }),
    })
    expect(info?.priceStep).toBeUndefined()
    expect(info).toHaveProperty('priceIncrements', [
      { lowEdge: 0, increment: 0.001 },
      { lowEdge: 10, increment: 0.05 },
    ])
  },
)

it('does not invent forex pip money or a minimum tick without provider facts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ symbol: {}, metadata: {} })),
  )
  const forex = { ticker: 'USDJPY', currency: 'JPY', type: 'forex' as const, exchange: 'IDEALPRO' }
  const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const info = await adapter.getTradingSymbolInfo?.({ symbol: forex })
  expect(info?.pipValue).toBeUndefined()
  expect(info?.priceStep).toBeUndefined()
  const pip = vi.fn()
  const stop = adapter.subscribePipValue?.({ symbol: forex }, pip)
  expect(pip).toHaveBeenCalledWith(undefined)
  stop?.()
})

it('leaves native forex price authority unknown when only a minimum tick is available', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ symbol: { minTick: 0.001 }, metadata: {} })),
  )
  const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  expect(
    await adapter.getTradingSymbolInfo?.({
      symbol: { ticker: 'USDJPY', currency: 'JPY', type: 'forex', exchange: 'IDEALPRO' },
    }),
  ).not.toHaveProperty('priceStep')
})

it('keeps unsupported native readback visible with exact identity and refuses tradability or serialization', async () => {
  const readback = toTradingState(
    {
      ...state(),
      positions: [
        {
          id: 'test-unsupported-position',
          accountId: 'test-account',
          quantity: 1,
          symbol: {
            symbol: 'DISPLAY',
            canonicalSymbol: 'IBKR:321',
            assetClass: 'unknown',
            currency: 'USD',
            exchange: 'SMART',
            contractIdentity: { securityType: 'IOPT', conId: 321 },
          },
        },
      ],
    },
    'IBKR',
    'paper',
  )
  const position = readback.positions[0]
  if (!position) throw new Error('Unsupported readback missing')
  expect(position.symbol).toMatchObject({ canonicalSymbol: 'IBKR:321', brokerSymbol: 'IBKR:321' })
  expect(position.symbol.type).toBeUndefined()
  vi.stubGlobal('fetch', vi.fn())
  const adapter = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  expect(await adapter.isTradable?.({ symbol: position.symbol })).toMatchObject({ tradable: false })
  expect(() =>
    toBackendDraft({ symbol: position.symbol, type: 'market', side: 'buy', quantity: 1 }),
  ).toThrow('instrument type')
})

it('rejects an unclassified SDK draft instead of allowing stock inference', () => {
  const { type: _type, ...unclassified } = symbol
  expect(() =>
    toBackendDraft({ symbol: unclassified, type: 'market', side: 'buy', quantity: 1 }),
  ).toThrow('instrument type')
})
