import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const workspace = fileURLToPath(new URL('../../..', import.meta.url))
const children: ChildProcess[] = []

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not allocate a port')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Process startup is asynchronous.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM')
    if (child.exitCode === null) await once(child, 'exit')
  }
})

const CAPABILITY = 'integration-test-capability-that-is-long-enough'
const UI_ORIGIN = 'http://localhost:3000'

interface StartedProcess {
  readonly httpPort: number
  readonly bridgePort: number
}

async function startProcess(): Promise<StartedProcess> {
  const httpPort = await availablePort()
  const bridgePort = await availablePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/mcp/src/main.ts'], {
    cwd: workspace,
    env: {
      ...process.env,
      INTERNAL_PROXY_CAPABILITY: CAPABILITY,
      TRADESCRIPT_MCP_HTTP_PORT: String(httpPort),
      TRADESCRIPT_MCP_BRIDGE_PORT: String(bridgePort),
      UI_ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  await waitFor(`http://127.0.0.1:${httpPort}/healthz`)
  return { httpPort, bridgePort }
}

async function issueSession(httpPort: number): Promise<{
  sessionId: string
  bridgeUrl: string
  bridgeToken: string
}> {
  const response = await fetch(`http://127.0.0.1:${httpPort}/browser-session`, {
    method: 'POST',
    headers: { 'x-terminal-proxy-capability': CAPABILITY },
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { sessionId: string; bridgeUrl: string; bridgeToken: string }
}

function attachMessage(session: { sessionId: string; bridgeToken: string }): string {
  return JSON.stringify({
    type: 'attach',
    sessionId: session.sessionId,
    token: session.bridgeToken,
    title: 'Test terminal',
    surfaces: [
      {
        target: { scope: 'session' },
        kind: 'terminal',
        controllerIds: ['trading'],
        capabilities: [],
      },
    ],
  })
}

async function attachBrowser(httpPort: number) {
  const session = await issueSession(httpPort)
  const socket = new WebSocket(session.bridgeUrl, { origin: UI_ORIGIN })
  await once(socket, 'open')
  socket.send(attachMessage(session))
  await once(socket, 'message')
  return { ...session, socket }
}

async function connectClient(httpPort: number) {
  const client = new Client({ name: 'session-ownership-test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`)),
  )
  return client
}

async function pendingContext(client: Client, session: Awaited<ReturnType<typeof attachBrowser>>) {
  const received = once(session.socket, 'message')
  const result = client.callTool({
    name: 'tradescript_get_context',
    arguments: { sessionId: session.sessionId, target: { scope: 'session' } },
  })
  const [raw] = await received
  const request = JSON.parse(raw.toString()) as { id: string }
  return { result, id: request.id }
}

it('keeps pending requests in other sessions when an attached or unpaired socket closes', async () => {
  const { httpPort } = await startProcess()
  const first = await attachBrowser(httpPort)
  const second = await attachBrowser(httpPort)
  const client = await connectClient(httpPort)
  try {
    const a = await pendingContext(client, first)
    const b = await pendingContext(client, second)
    const closed = once(second.socket, 'close')
    second.socket.close()
    await closed
    expect(await b.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'BRIDGE_REQUEST_ABANDONED' } },
    })
    const unpaired = new WebSocket(first.bridgeUrl, { origin: UI_ORIGIN })
    await once(unpaired, 'open')
    const unpairedClosed = once(unpaired, 'close')
    unpaired.close()
    await unpairedClosed
    first.socket.send(JSON.stringify({ type: 'response', id: a.id, result: { owner: 'first' } }))
    expect(await a.result).toMatchObject({ structuredContent: { owner: 'first' } })
  } finally {
    first.socket.terminate()
    second.socket.terminate()
    await client.close()
  }
})

it('does not accept a pending request response from another authenticated session', async () => {
  const { httpPort } = await startProcess()
  const first = await attachBrowser(httpPort)
  const second = await attachBrowser(httpPort)
  const client = await connectClient(httpPort)
  try {
    const pending = await pendingContext(client, first)
    const closed = once(second.socket, 'close')
    second.socket.send(
      JSON.stringify({ type: 'response', id: pending.id, result: { owner: 'wrong' } }),
    )
    expect((await closed)[0]).toBe(1007)
    first.socket.send(
      JSON.stringify({ type: 'response', id: pending.id, result: { owner: 'first' } }),
    )
    expect(await pending.result).toMatchObject({ structuredContent: { owner: 'first' } })
  } finally {
    first.socket.terminate()
    second.socket.terminate()
    await client.close()
  }
})

describe('TradeScript local MCP process', () => {
  it('rejects a pairing token that is reused after a successful attach', async () => {
    const { httpPort } = await startProcess()
    const session = await issueSession(httpPort)

    const first = new WebSocket(session.bridgeUrl, { origin: UI_ORIGIN })
    await once(first, 'open')
    first.send(attachMessage(session))
    await once(first, 'message')

    // The token was consumed by the first attach, so a second socket must not be able to pair.
    const second = new WebSocket(session.bridgeUrl, { origin: UI_ORIGIN })
    await once(second, 'open')
    second.send(attachMessage(session))
    const [code] = (await once(second, 'close')) as [number]
    expect(code).toBe(1008)

    first.close()
  })

  it('rejects a bridge upgrade from an origin other than the configured UI origin', async () => {
    const { httpPort, bridgePort } = await startProcess()
    const session = await issueSession(httpPort)
    expect(session.bridgeUrl).toContain(String(bridgePort))

    const socket = new WebSocket(session.bridgeUrl, { origin: 'http://evil.example' })
    const [error] = (await once(socket, 'error')) as [Error]
    expect(error).toBeInstanceOf(Error)
    expect(socket.readyState).not.toBe(WebSocket.OPEN)
  })

  it('refuses a browser session request without the terminal proxy capability', async () => {
    const { httpPort } = await startProcess()
    const response = await fetch(`http://127.0.0.1:${httpPort}/browser-session`, { method: 'POST' })
    expect(response.status).toBe(403)
  })

  it('rejects an attach that presents an unknown token', async () => {
    const { httpPort } = await startProcess()
    const session = await issueSession(httpPort)

    const socket = new WebSocket(session.bridgeUrl, { origin: UI_ORIGIN })
    await once(socket, 'open')
    socket.send(attachMessage({ ...session, bridgeToken: 'y'.repeat(43) }))
    const [code] = (await once(socket, 'close')) as [number]
    expect(code).toBe(1008)
  })

  it('runs every stable tool through an authenticated browser bridge', async () => {
    const { httpPort } = await startProcess()
    const browserSession = await issueSession(httpPort)

    const bridge = new WebSocket(browserSession.bridgeUrl, { origin: UI_ORIGIN })
    await once(bridge, 'open')
    bridge.send(
      JSON.stringify({
        type: 'attach',
        sessionId: browserSession.sessionId,
        token: browserSession.bridgeToken,
        title: 'Test terminal',
        surfaces: [
          {
            target: { scope: 'session' },
            kind: 'terminal',
            controllerIds: ['trading'],
            capabilities: [],
          },
        ],
      }),
    )
    await once(bridge, 'message')

    const delegated: Array<{ method: string; params: Record<string, unknown> }> = []
    bridge.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as {
        type: string
        id?: string
        method?: string
        params?: unknown
      }
      if (request.type !== 'request' || request.id === undefined) return
      delegated.push({
        method: request.method ?? '',
        params: (request.params ?? {}) as Record<string, unknown>,
      })
      const result =
        request.method === 'snapshot'
          ? { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', byteLength: 8 }
          : request.method === 'listControls'
            ? {
                sessionId: browserSession.sessionId,
                controls: [{ controlId: 'trading.getState' }],
                total: 1,
              }
            : request.method === 'subscribe'
              ? { sessionId: browserSession.sessionId, subscriptions: [] }
              : request.method === 'call'
                ? { operationId: 'test', origin: 'mcp', value: { connectionStatus: 'connected' } }
                : request.method === 'batch'
                  ? { sessionId: browserSession.sessionId, results: [], stoppedEarly: false }
                  : {
                      sessionId: browserSession.sessionId,
                      target: { scope: 'session' },
                      revisions: {},
                    }
      bridge.send(JSON.stringify({ type: 'response', id: request.id, result }))
    })

    const client = new Client({ name: 'mcp-integration-test', version: '0.1.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`)),
    )
    try {
      const listed = await client.listTools()
      expect(listed.tools.map(({ name }) => name).sort()).toEqual([
        'tradescript_batch',
        'tradescript_call',
        'tradescript_get_context',
        'tradescript_list_controls',
        'tradescript_snapshot',
        'tradescript_subscribe',
      ])
      const base = { sessionId: browserSession.sessionId }
      const target = { scope: 'session' }
      const contextResult = await client.callTool({
        name: 'tradescript_get_context',
        arguments: { ...base, target },
      })
      expect(contextResult.isError, JSON.stringify(contextResult)).not.toBe(true)
      await expect(
        client.callTool({ name: 'tradescript_list_controls', arguments: { ...base, target } }),
      ).resolves.not.toMatchObject({ isError: true })
      await expect(
        client.callTool({
          name: 'tradescript_call',
          arguments: { ...base, target, controlId: 'trading.getState' },
        }),
      ).resolves.not.toMatchObject({ isError: true })
      await expect(
        client.callTool({
          name: 'tradescript_batch',
          arguments: { ...base, calls: [{ target, controlId: 'trading.getState' }] },
        }),
      ).resolves.not.toMatchObject({ isError: true })
      await expect(
        client.callTool({ name: 'tradescript_subscribe', arguments: { ...base, action: 'list' } }),
      ).resolves.not.toMatchObject({ isError: true })
      const snapshot = await client.callTool({
        name: 'tradescript_snapshot',
        arguments: { ...base, target },
      })
      expect(snapshot.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/png' })]),
      )

      const resource = await client.readResource({ uri: 'tradescript://sessions' })
      expect(JSON.stringify(resource.contents)).toContain(browserSession.sessionId)

      // Every delegated request must carry the calling MCP client's identity, because the browser
      // attributes receipts to it. A batch carries it once, not per call.
      expect(delegated.length).toBeGreaterThan(0)
      const consumerIds = new Set(delegated.map(({ params }) => params.consumerId))
      expect(consumerIds.size).toBe(1)
      const [consumerId] = [...consumerIds]
      expect(typeof consumerId).toBe('string')
      expect(consumerId).not.toBe(browserSession.sessionId)

      const batch = delegated.find(({ method }) => method === 'batch')
      expect(batch).toBeDefined()
      const calls = batch?.params.calls as readonly Record<string, unknown>[]
      expect(calls).toHaveLength(1)
      expect(calls[0]).not.toHaveProperty('consumerId')
    } finally {
      await client.close()
      bridge.close()
    }
  })
})
