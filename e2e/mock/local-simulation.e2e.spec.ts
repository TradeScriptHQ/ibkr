import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, type Page, test } from '@playwright/test'

interface AttachedSession {
  readonly id: string
  readonly surfaces: ReadonlyArray<{ readonly target: { readonly scope: string } }>
}

interface DynamicObject {
  readonly [key: string]: unknown
  readonly operationId?: string
  readonly origin?: string
  readonly value?: unknown
  readonly revisions?: { readonly trading?: Record<string, unknown> }
  readonly confirmId?: string
  readonly positions?: DynamicObject[]
  readonly executions?: DynamicObject[]
  readonly accounts?: Array<DynamicObject & { readonly balance?: DynamicObject }>
}

async function attachedSession(endpoint: string, existing: Set<string>): Promise<AttachedSession> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/sessions', endpoint))
    if (response.ok) {
      const sessions = (await response.json()) as AttachedSession[]
      const attached = sessions.find(
        (session) =>
          !existing.has(session.id) &&
          session.surfaces.some(({ target }) => target.scope === 'session'),
      )
      if (attached) return attached
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('The simulated terminal did not attach to the MCP bridge')
}

function jsonToolResult(result: { content?: unknown; [key: string]: unknown }): DynamicObject {
  const text = (Array.isArray(result.content) ? result.content : []).find(
    (entry): entry is { type: 'text'; text: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { type?: unknown }).type === 'text' &&
      typeof (entry as { text?: unknown }).text === 'string',
  )
  if (text === undefined) throw new Error('MCP tool returned no JSON text result')
  return JSON.parse(text.text) as DynamicObject
}

async function openMockMcp(page: Page) {
  const bootstrapResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/mcp-local/browser-session') && response.status() === 201,
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByText('Agent Console', { exact: true }).click()
  await expect(page.getByText('Local MCP ready', { exact: true })).toBeVisible()

  const { mcpUrl: endpoint } = (await (await bootstrapResponse).json()) as { mcpUrl: string }
  const attached = await attachedSession(endpoint, new Set())
  const target = { scope: 'session' } as const
  const client = new Client({ name: 'ibkr-terminal-mock-e2e', version: '0.1.0' })
  // @ts-expect-error MCP Transport declares sessionId optional, but its implementation includes undefined.
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  let requestSequence = 0

  const getContext = async () =>
    jsonToolResult(
      await client.callTool({
        name: 'tradescript_get_context',
        arguments: { sessionId: attached.id, target },
      }),
    )
  const call = async (controlId: string, args: unknown[], guarded = false) => {
    const context = guarded ? await getContext() : undefined
    const requestId = `mock-option-${++requestSequence}`
    const result = await client.callTool({
      name: 'tradescript_call',
      arguments: {
        sessionId: attached.id,
        target,
        controlId,
        args,
        requestId,
        ...(guarded
          ? { expectedRevisions: context?.revisions?.trading as Record<string, unknown> }
          : {}),
      },
    })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    const receipt = jsonToolResult(result)
    expect(receipt).toMatchObject({ operationId: requestId, origin: 'mcp' })
    if (controlId === 'trading.reversePosition' || controlId === 'trading.cancelOrder')
      return receipt
    if (typeof receipt.value !== 'object' || receipt.value === null) {
      throw new Error(`${controlId} returned no object value`)
    }
    return receipt.value as DynamicObject
  }

  return { client, call }
}

test('mock mode is unmistakably labelled and renders deterministic market surfaces', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Simulated Workstation', { exact: true })).toBeVisible()
  await expect(page.getByText('Simulated session', { exact: true })).toBeVisible()
  await expect(page.getByText('Local Simulation', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('199.95', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('200.05', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Level II data unavailable', { exact: false })).toHaveCount(0)

  await page.getByText('Time & Sales', { exact: true }).click()
  await expect(page.getByText('NASDAQ', { exact: true }).first()).toBeVisible()
  await expect(
    page.getByText('IBKR tick-by-tick data is unavailable', { exact: false }),
  ).toHaveCount(0)
})

test('MCP performs and reconciles a complete simulated option round trip', async ({ page }) => {
  const { client, call } = await openMockMcp(page)

  try {
    const initial = await call('trading.getState', [])
    expect(initial).toMatchObject({
      activeAccountId: 'MOCK-PAPER',
      positions: [],
      executions: [],
    })
    const symbol = {
      ticker: 'AAPL',
      canonicalSymbol: 'mock:AAPL',
      brokerSymbol: 'AAPL',
      exchange: 'SMART',
      listedExchange: 'NASDAQ',
      currency: 'USD',
      type: 'stock' as const,
      provider: 'LOCAL-MOCK',
    }
    const contractRequest = {
      underlying: 'AAPL',
      underlyingSymbolInfo: symbol,
      expiration: '2026-10-16',
      strike: 200,
      right: 'call' as const,
      multiplier: 100,
      exchange: 'SMART',
      currency: 'USD',
      symbol: 'AAPL-2026-10-16-C-200',
    }
    const resolved = await call('trading.resolveOptionContract', [
      { contract: contractRequest, accountId: 'MOCK-PAPER' },
    ])
    expect(resolved.tradable).toBe(true)
    const contract = resolved.contract
    if (
      typeof contract !== 'object' ||
      contract === null ||
      !('symbol' in contract) ||
      typeof contract.symbol !== 'string'
    ) {
      throw new Error('The simulated provider returned no resolved option contract')
    }
    const context = {
      accountId: 'MOCK-PAPER',
      symbol,
      currency: 'USD',
      lastPrice: 200,
      bid: 199.95,
      ask: 200.05,
    }
    const draft = (side: 'buy' | 'sell', positionEffect: 'open' | 'close', price: number) => ({
      accountId: 'MOCK-PAPER',
      symbol,
      side,
      type: 'market',
      quantity: 1,
      optionLegs: [{ contract, side, positionEffect, quantity: 1, ratio: 1, price }],
      customFields: { qualification: 'mock-option-round-trip' },
    })

    const buyDraft = draft('buy', 'open', 2.5)
    const buyPreview = await call('trading.previewOrder', [buyDraft, context])
    expect(buyPreview).toMatchObject({ accepted: true, estimatedMargin: 62.5 })
    const bought = await call(
      'trading.placeOrder',
      [{ ...buyDraft, confirmId: buyPreview.confirmId }, context],
      true,
    )
    expect(bought).toMatchObject({ accepted: true, status: 'accepted' })

    const opened = await call('trading.getState', [])
    expect(opened.positions).toHaveLength(1)
    expect(opened.positions?.[0]).toMatchObject({
      side: 'long',
      quantity: 1,
      averagePrice: 2.5,
      optionContract: { symbol: contract.symbol, multiplier: 100 },
    })
    expect(opened.executions).toHaveLength(1)
    expect(opened.accounts?.[0]?.balance).toMatchObject({ cash: 99_749, equity: 99_999 })

    const sellDraft = draft('sell', 'close', 3)
    const sellPreview = await call('trading.previewOrder', [sellDraft, context])
    expect(sellPreview).toMatchObject({ accepted: true, estimatedMargin: 75 })
    await call(
      'trading.placeOrder',
      [{ ...sellDraft, confirmId: sellPreview.confirmId }, context],
      true,
    )

    const closed = await call('trading.getState', [])
    expect(closed.positions).toEqual([])
    expect(closed.executions).toHaveLength(2)
    expect(closed.executions?.[1]).toMatchObject({
      side: 'sell',
      price: 3,
      quantity: 1,
      optionContract: { symbol: contract.symbol },
      metadata: {
        keys: expect.arrayContaining(['provider', 'realizedPnl', 'synthetic']),
        valuesOmitted: true,
      },
    })
    expect(closed.accounts?.[0]?.balance).toMatchObject({ cash: 100_048, equity: 100_048 })
  } finally {
    await client.close()
  }
})

test('MCP activates linked protection, fills a target and cancels its exact sibling', async ({
  page,
}) => {
  const { client, call } = await openMockMcp(page)
  try {
    const symbol = {
      ticker: 'AAPL',
      canonicalSymbol: 'mock:AAPL',
      brokerSymbol: 'AAPL',
      currency: 'USD',
      type: 'stock',
      provider: 'LOCAL-MOCK',
    }
    const context = { symbol, accountId: 'MOCK-PAPER', lastPrice: 200, bid: 199.95, ask: 200.05 }
    const draft = {
      symbol,
      accountId: 'MOCK-PAPER',
      side: 'buy',
      type: 'market',
      quantity: 2,
      exits: {
        levels: [
          {
            id: 'rendered-bracket',
            quantity: 2,
            takeProfit: { price: 210 },
            stopLoss: { kind: 'fixed', triggerPrice: 190 },
          },
        ],
      },
    }
    const preview = await call('trading.previewOrder', [draft, context])
    expect(preview.accepted).toBe(true)
    const placed = await call(
      'trading.placeOrder',
      [{ ...draft, confirmId: preview.confirmId }, context],
      true,
    )
    const parent = placed.order as DynamicObject
    const opened = await call('trading.getState', [])
    const children = (opened.orders as DynamicObject[]).filter(
      (order) => order.parentId === parent.id,
    )
    expect(children).toHaveLength(2)
    const target = children.find((order) => order.type === 'limit')
    const stop = children.find((order) => order.type === 'stop')
    expect(target).toMatchObject({ status: 'working', quantity: 2, parentType: 'order' })
    expect(stop).toMatchObject({ status: 'working', quantity: 2 })
    if (typeof target?.id !== 'string') throw new Error('Missing exact synthetic target')
    const amended = await call('trading.previewModifyOrder', [
      target.id,
      { price: 199.95 },
      context,
    ])
    expect(amended.accepted).toBe(true)
    await call(
      'trading.modifyOrder',
      [target.id, { price: 199.95 }, context, { confirmId: amended.confirmId }],
      true,
    )
    const closed = await call('trading.getState', [])
    expect(closed.positions).toEqual([])
    expect(closed.executions).toHaveLength(2)
    expect((closed.orders as DynamicObject[]).find((order) => order.id === stop?.id)).toMatchObject(
      { status: 'cancelled' },
    )
    await expect(page.getByText('Simulated session', { exact: true })).toBeVisible()
  } finally {
    await client.close()
  }
})

test('MCP reverses the exact registered option without trading its underlying stock', async ({
  page,
}) => {
  const { client, call } = await openMockMcp(page)
  try {
    const symbol = {
      ticker: 'AAPL',
      canonicalSymbol: 'mock:AAPL',
      brokerSymbol: 'AAPL',
      exchange: 'SMART',
      currency: 'USD',
      type: 'stock',
      provider: 'LOCAL-MOCK',
    }
    const resolved = await call('trading.resolveOptionContract', [
      {
        accountId: 'MOCK-PAPER',
        contract: {
          underlying: 'AAPL',
          underlyingSymbolInfo: symbol,
          expiration: '2026-10-16',
          strike: 200,
          right: 'call',
          multiplier: 100,
          exchange: 'SMART',
          currency: 'USD',
          symbol: 'AAPL-2026-10-16-C-200',
        },
      },
    ])
    const context = { symbol, accountId: 'MOCK-PAPER', lastPrice: 200, bid: 199.95, ask: 200.05 }
    const draft = {
      symbol,
      accountId: 'MOCK-PAPER',
      side: 'buy',
      type: 'market',
      quantity: 1,
      optionLegs: [
        {
          contract: resolved.contract,
          side: 'buy',
          positionEffect: 'open',
          quantity: 1,
          ratio: 1,
          price: 2.5,
        },
      ],
    }
    const preview = await call('trading.previewOrder', [draft, context])
    await call('trading.placeOrder', [{ ...draft, confirmId: preview.confirmId }, context], true)
    const opened = await call('trading.getState', [])
    const position = opened.positions?.[0]
    if (typeof position?.id !== 'string') throw new Error('Missing exact synthetic option position')
    await call(
      'trading.reversePosition',
      [position.id, { ...context, symbol: position.symbol }],
      true,
    )
    const reversed = await call('trading.getState', [])
    expect(reversed.positions).toMatchObject([
      {
        side: 'short',
        quantity: 1,
        averagePrice: 2.49,
        symbol: position.symbol,
        optionContract: {
          brokerContractId: (resolved.contract as DynamicObject).brokerContractId,
          multiplier: 100,
        },
      },
    ])
    expect(reversed.executions).toHaveLength(3)
    expect(reversed.executions?.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          side: 'sell',
          quantity: 1,
          price: 2.49,
          symbol: position.symbol,
        }),
      ]),
    )
    expect(
      (reversed.orders as DynamicObject[])
        .slice(1)
        .map((order) => (order.optionLegs as DynamicObject[])?.[0]?.positionEffect),
    ).toEqual(['close', 'open'])
    await expect(page.getByText('Simulated session', { exact: true })).toBeVisible()
  } finally {
    await client.close()
  }
})

let brokerRequests: string[] = []
test.beforeEach(async ({ page }) => {
  brokerRequests = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/ibkr/'))
      brokerRequests.push(request.method())
  })
})
test.afterEach(async ({ page }) => {
  expect(brokerRequests, 'Simulation must not call the IBKR data or order routes').toEqual([])
  const broker = await page.evaluate(async () => {
    const response = await fetch('/api/v1/ibkr/state', {
      headers: { 'x-tradescript-client': 'terminal-v1' },
    })
    if (!response.ok) throw new Error('Isolated gateway state unavailable')
    return response.json()
  })
  expect(broker).toMatchObject({
    connectionStatus: 'disconnected',
    accounts: [],
    positions: [],
    orders: [],
    executions: [],
  })
})
