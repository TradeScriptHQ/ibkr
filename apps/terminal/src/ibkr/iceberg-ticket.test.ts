import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubSymbolRules() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ metadata: {} })),
  )
}

const smartStock = {
  ticker: 'AAPL',
  brokerSymbol: 'AAPL',
  exchange: 'SMART',
  listedExchange: 'NASDAQ',
  currency: 'USD',
  type: 'stock' as const,
}

it('advertises a conditional Iceberg field with displaySize less-than quantity validation', async () => {
  stubSymbolRules()
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })

  const info = await broker.getTradingSymbolInfo?.({ symbol: smartStock })
  const sections = info?.orderTicketSettings?.fieldLayout?.sections
  const fields = sections?.flatMap((section) => section.fields)

  expect(info?.supportsHidden).toBe(false)
  expect(info?.orderTicketCustomFields?.some((field) => field.id === 'hidden')).toBe(false)
  expect(sections?.[0]?.description).toBeUndefined()
  expect(fields?.find((field) => field.id === 'displaySize')?.description).toBeUndefined()
  expect(sections?.[0]?.placement).toBe('order-options')
  expect(sections?.[0]?.columns).toBe(3)
  expect(fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'orderVisibility',
        columnSpan: 2,
        showLabel: false,
        kind: 'checkbox',
        inlineLabel: true,
        checkedValue: 'iceberg',
        uncheckedValue: 'visible',
      }),
      expect.objectContaining({
        id: 'displaySize',
        showLabel: false,
        enabledWhen: expect.objectContaining({ field: 'orderVisibility', equals: 'iceberg' }),
        showRequiredMessage: false,
        requiredWhen: expect.objectContaining({ field: 'orderVisibility', equals: 'iceberg' }),
        validations: [
          expect.objectContaining({
            operator: 'lt',
            other: { target: 'draft', field: 'quantity' },
          }),
        ],
      }),
    ]),
  )
})

it('does not advertise Iceberg for a non-SMART route', async () => {
  stubSymbolRules()
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })

  const info = await broker.getTradingSymbolInfo?.({
    symbol: { ...smartStock, exchange: 'ISLAND' },
  })

  expect(info?.orderTicketSettings?.fieldLayout).toBeUndefined()
})

it('sends an explicit clear when a modification returns to Show all', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({
      order: {
        id: '7',
        accountId: 'DU123',
        symbol: {
          symbol: 'AAPL',
          exchange: 'SMART',
          primaryExchange: 'NASDAQ',
          currency: 'USD',
          assetClass: 'stock',
        },
        side: 'buy',
        type: 'limit',
        duration: 'day',
        quantity: 100,
        limitPrice: 300,
        status: 'working',
        submittedAt: '2026-09-10T12:00:00.000Z',
        updatedAt: '2026-09-10T12:00:00.000Z',
      },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  if (!broker.modifyOrder) throw new Error('Order modification is required')

  await broker.modifyOrder(
    '7',
    { customFields: { orderVisibility: 'visible', displaySize: 25 } },
    { symbol: smartStock, accountId: 'DU123' },
  )

  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
  expect(body.patch).toMatchObject({
    displaySize: null,
    customFields: { orderVisibility: 'visible' },
  })
})
