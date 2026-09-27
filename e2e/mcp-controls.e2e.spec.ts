import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import { expect, test } from './support/fixtures.js'
import { cleanUp, stockReferenceQuote } from './support/paper-orders.js'
import { browserHeaders, openTerminalSession, pollBrokerState } from './support/session.js'

const MCP_URL = new URL('http://127.0.0.1:39182/mcp')

interface AttachedSession {
  readonly id: string
  readonly surfaces: ReadonlyArray<{
    readonly target: {
      readonly scope: 'session' | 'chart' | 'widget'
      readonly chartId?: string
      readonly widgetId?: string
    }
    readonly kind: string
  }>
}

async function attachedSession(existing: Set<string>): Promise<AttachedSession> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const response = await fetch('http://127.0.0.1:39182/sessions')
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
  throw new Error('The browser did not attach to the MCP bridge')
}

function jsonToolResult(result: {
  content?: unknown
  [key: string]: unknown
}): Record<string, unknown> {
  const text = (Array.isArray(result.content) ? result.content : []).find(
    (entry): entry is { type: 'text'; text: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { type?: unknown }).type === 'text' &&
      typeof (entry as { text?: unknown }).text === 'string',
  )
  if (text === undefined) throw new Error('MCP tool returned no JSON text result')
  return JSON.parse(text.text) as Record<string, unknown>
}

test('MCP discovery and trading access match the current connection', async ({ page, request }) => {
  await openTerminalSession(request)
  const lease = await (
    await request.get('/api/v1/tradescript/bootstrap', { headers: browserHeaders })
  ).json()
  const existing = new Set<string>(
    (await (await fetch('http://127.0.0.1:39182/sessions')).json()).map(
      (session: AttachedSession) => session.id,
    ),
  )
  await page.goto('/')
  await page.getByText('Agent Console', { exact: true }).click()
  await expect(page.getByText('Local MCP ready', { exact: true })).toBeVisible()

  const attached = await attachedSession(existing)
  const sessionSurface = attached.surfaces.find(({ target }) => target.scope === 'session')
  expect(sessionSurface, 'TradeScript should register a session target').toBeTruthy()

  const client = new Client({ name: 'ibkr-terminal-e2e', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(MCP_URL)
  // @ts-expect-error MCP Transport declares sessionId optional, but its implementation includes undefined.
  await client.connect(transport)

  try {
    const tools = await client.listTools()
    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
      'tradescript_batch',
      'tradescript_call',
      'tradescript_get_context',
      'tradescript_list_controls',
      'tradescript_snapshot',
      'tradescript_subscribe',
    ])

    const sessionsResource = await client.readResource({ uri: 'tradescript://sessions' })
    expect(JSON.stringify(sessionsResource.contents)).toContain(attached.id)

    const context = jsonToolResult(
      await client.callTool({
        name: 'tradescript_get_context',
        arguments: { sessionId: attached.id, target: { scope: 'session' } },
      }),
    )
    expect(context, JSON.stringify(context, null, 2)).toHaveProperty('sessionId', attached.id)
    expect(context.target).toEqual({ scope: 'session' })
    expect(context).toHaveProperty('revisions')

    const controls = jsonToolResult(
      await client.callTool({
        name: 'tradescript_list_controls',
        arguments: {
          sessionId: attached.id,
          target: { scope: 'session' },
          controller: 'trading',
          limit: 100,
        },
      }),
    )
    expect(controls.sessionId).toBe(attached.id)
    expect(controls.total).toEqual(expect.any(Number))
    if (!lease.paperTrading.enabled) {
      expect(controls.controls).toEqual([])
      const denied = await client.callTool({
        name: 'tradescript_call',
        arguments: {
          sessionId: attached.id,
          target: { scope: 'session' },
          controlId: 'trading.getState',
          args: [],
          requestId: 'e2e-disabled-agent',
        },
      })
      expect(denied.isError, 'Disabled agent access must reject invocation').toBe(true)
      test.info().annotations.push({
        type: 'agent-access',
        description: 'Agent trading disabled; MCP invocation denied as configured.',
      })
      return
    }
    expect(JSON.stringify(controls.controls)).toContain('trading.getState')

    const call = jsonToolResult(
      await client.callTool({
        name: 'tradescript_call',
        arguments: {
          sessionId: attached.id,
          target: { scope: 'session' },
          controlId: 'trading.getState',
          args: [],
          requestId: 'mcp-e2e-read-state',
        },
      }),
    )
    expect(call.operationId).toBe('mcp-e2e-read-state')
    expect(call.origin).toBe('mcp')
    expect(call.value).toMatchObject({ connectionStatus: 'connected' })
    const brokerState = call.value as { activeAccountId?: string; accounts: Array<{ id: string }> }
    expect(brokerState.activeAccountId?.startsWith('DU')).toBe(true)
    expect(brokerState.accounts.some((account) => account.id === brokerState.activeAccountId)).toBe(
      true,
    )

    const subscriptions = jsonToolResult(
      await client.callTool({
        name: 'tradescript_subscribe',
        arguments: { sessionId: attached.id, action: 'list' },
      }),
    )
    expect(subscriptions.subscriptions).toEqual([])
  } finally {
    await client.close()
  }
})

test('standard MCP previews, places, modifies, and cancels a real paper order @paper', async ({
  page,
  request,
}) => {
  test.setTimeout(3 * 60_000)
  await openTerminalSession(request)
  const lease = await (
    await request.get('/api/v1/tradescript/bootstrap', { headers: browserHeaders })
  ).json()
  test.skip(!lease.paperTrading.enabled, 'Agent trading is disabled in the current connection.')
  const existing = new Set<string>(
    (await (await fetch('http://127.0.0.1:39182/sessions')).json()).map(
      (session: AttachedSession) => session.id,
    ),
  )
  await page.goto('/')
  await page.getByText('Agent Console', { exact: true }).click()
  await expect(page.getByText('Local MCP ready', { exact: true })).toBeVisible()

  const attached = await attachedSession(existing)
  const target = { scope: 'session' } as const
  const client = new Client({ name: 'ibkr-terminal-trading-e2e', version: '0.1.0' })
  // @ts-expect-error MCP Transport declares sessionId optional, but its implementation includes undefined.
  await client.connect(new StreamableHTTPClientTransport(MCP_URL))
  const qualification = `e2e-mcp-order-${Date.now()}`
  let orderId: string | undefined
  let cleanupDraft: TradingOrderDraft | undefined

  const getContext = async () =>
    jsonToolResult(
      await client.callTool({
        name: 'tradescript_get_context',
        arguments: { sessionId: attached.id, target },
      }),
    )
  const callControl = async (
    controlId: string,
    args: unknown[],
    requestId: string,
    guarded = false,
  ) => {
    const context = guarded ? await getContext() : undefined
    const result = await client.callTool({
      name: 'tradescript_call',
      arguments: {
        sessionId: attached.id,
        target,
        controlId,
        args,
        requestId,
        ...(guarded
          ? {
              expectedRevisions: (context?.revisions as Record<string, unknown> | undefined)
                ?.trading,
            }
          : {}),
      },
    })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    const receipt = jsonToolResult(result)
    expect(receipt.operationId).toBe(requestId)
    expect(receipt.origin).toBe('mcp')
    return receipt.value as any
  }

  try {
    const state = await callControl('trading.getState', [], `${qualification}-state`)
    const accountId = state.activeAccountId as string
    expect(accountId).toBeTruthy()
    const quote = await stockReferenceQuote(request)
    test.info().annotations.push({
      type: 'IBKR reference data',
      description: `AAPL: ${quote.status}; only used to keep the MCP lifecycle limit away from the market`,
    })
    const referencePrice = Number(quote.bid ?? quote.last ?? quote.ask ?? quote.previousClose)
    expect(referencePrice).toBeGreaterThan(0)
    const entryPrice = Number((referencePrice * 0.98).toFixed(2))
    const symbol = {
      ticker: 'AAPL',
      brokerSymbol: 'AAPL',
      name: 'APPLE INC',
      exchange: 'SMART',
      listedExchange: 'NASDAQ',
      currency: 'USD',
      type: 'stock' as const,
    }
    const draft: TradingOrderDraft = {
      accountId,
      symbol,
      side: 'buy',
      type: 'limit',
      duration: { type: 'day' },
      quantity: 1,
      price: entryPrice,
      customFields: { qualification },
    }
    cleanupDraft = draft
    const tradingContext = { accountId, symbol, currency: 'USD' }

    const preview = await callControl(
      'trading.previewOrder',
      [draft, tradingContext],
      `${qualification}-preview`,
    )
    expect(preview.accepted, preview.message ?? JSON.stringify(preview)).toBe(true)
    expect(preview.confirmId).toEqual(expect.any(String))

    const placed = await callControl(
      'trading.placeOrder',
      [{ ...draft, confirmId: preview.confirmId }, tradingContext],
      `${qualification}-place`,
      true,
    )
    expect(placed.accepted, placed.message).toBe(true)
    orderId = placed.order.id as string
    expect(orderId).toMatch(/^\d+$/u)
    await pollBrokerState(request, (nextState) => {
      const order = nextState.orders?.find((candidate: any) => candidate.id === orderId)
      return order && ['pre-submitted', 'working'].includes(order.status) ? order : undefined
    })

    const modifyPreview = await callControl(
      'trading.previewModifyOrder',
      [orderId, { price: Number((entryPrice - 0.01).toFixed(2)) }, tradingContext],
      `${qualification}-modify-preview`,
    )
    expect(modifyPreview.accepted, modifyPreview.message ?? JSON.stringify(modifyPreview)).toBe(
      true,
    )

    const beforeModify = await (
      await request.get('/api/v1/ibkr/state', { headers: browserHeaders })
    ).json()
    const beforeDiagnostics = new Set(
      beforeModify.diagnostics.map((item: { id: string }) => item.id),
    )
    const modified = await callControl(
      'trading.modifyOrder',
      [
        orderId,
        {
          price: Number((entryPrice - 0.01).toFixed(2)),
          confirmId: modifyPreview.confirmId,
        },
        tradingContext,
      ],
      `${qualification}-modify`,
      true,
    )
    expect(modified.id).toBe(orderId)
    await pollBrokerState(request, (nextState) => {
      const order = nextState.orders?.find((candidate: any) => candidate.id === orderId)
      const acknowledged = nextState.diagnostics.some(
        (item: { id: string; text: string }) =>
          !beforeDiagnostics.has(item.id) &&
          item.text.includes(`IBKR raw openOrder orderId=${orderId} `),
      )
      return order?.limitPrice === Number((entryPrice - 0.01).toFixed(2)) && acknowledged
        ? order
        : undefined
    })

    await callControl(
      'trading.cancelOrder',
      [orderId, tradingContext],
      `${qualification}-cancel`,
      true,
    )
    await pollBrokerState(request, (nextState) => {
      const order = [...(nextState.orders ?? []), ...(nextState.ordersHistory ?? [])].find(
        (candidate: any) => candidate.id === orderId,
      )
      return order?.status === 'cancelled' ? order : undefined
    })
    orderId = undefined
  } finally {
    try {
      if (orderId) await cleanUp(page, request, orderId, cleanupDraft)
    } finally {
      await client.close()
    }
  }
})
