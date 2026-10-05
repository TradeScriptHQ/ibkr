import { EventEmitter, once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { BrowserBridge } from '../src/browser-bridge.js'
import { startMcpService } from '../src/service.js'
import { createTradeScriptMcpServer } from '../src/tools.js'

const UI_ORIGIN = 'http://localhost:3000'
const CAPABILITY = 'test-owned-proxy-capability-long-enough'

// Node fetch overwrites Host. Use the native HTTP client so these checks exercise the actual
// supplied authority on the wire rather than silently testing the service's default address.
async function wireRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, options, (response) => {
      response.resume()
      response.once('end', () => resolve({ status: response.statusCode ?? 0 }))
    })
    request.once('error', reject)
    request.end(options.body)
  })
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Port unavailable')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function localService() {
  const httpPort = await availablePort()
  const bridgePort = await availablePort()
  const service = await startMcpService({
    httpPort,
    bridgePort,
    uiOrigin: UI_ORIGIN,
    capability: CAPABILITY,
  })
  return { ...service, url: `http://127.0.0.1:${httpPort}` }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  readonly sent: Array<Record<string, unknown>> = []
  send(payload: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>)
    callback?.()
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
  terminate() {
    this.close()
  }
}

function attachedBridge(timeout?: number) {
  const bridge = new BrowserBridge(timeout)
  const socket = new FakeSocket()
  const session = bridge.issueSession()
  bridge.accept(socket as unknown as WebSocket)
  socket.emit(
    'message',
    JSON.stringify({
      type: 'attach',
      sessionId: session.sessionId,
      token: session.token,
      title: 'Test terminal',
      surfaces: [],
    }),
  )
  return { bridge, socket, sessionId: session.sessionId }
}

afterEach(() => vi.useRealTimers())

describe('local MCP HTTP trust boundary', () => {
  it.each(['/healthz', '/sessions', '/mcp'])(
    'rejects a hostile Host on %s before dispatch',
    async (path) => {
      const service = await localService()
      try {
        const response = await wireRequest(`${service.url}${path}`, {
          method: path === '/mcp' ? 'POST' : 'GET',
          headers: {
            host: 'rebound.example:39182',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          ...(path === '/mcp'
            ? {
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'initialize',
                  params: {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: { name: 'hostile-test', version: '1' },
                  },
                }),
              }
            : {}),
        })
        expect(response.status).toBe(403)
        expect((await wireRequest(`${service.url}/healthz`)).status).toBe(200)
      } finally {
        await service.close()
      }
    },
  )

  it('rejects an unexpected browser Origin on a valid loopback Host', async () => {
    const service = await localService()
    try {
      expect(
        (
          await wireRequest(`${service.url}/sessions`, {
            headers: { origin: 'http://hostile.example' },
          })
        ).status,
      ).toBe(403)
    } finally {
      await service.close()
    }
  })

  it('permits preserved UI Host only with the exact proxy capability', async () => {
    const service = await localService()
    try {
      expect(
        (await wireRequest(`${service.url}/healthz`, { headers: { host: 'localhost:3000' } }))
          .status,
      ).toBe(403)
      expect(
        (
          await wireRequest(`${service.url}/browser-session`, {
            method: 'POST',
            headers: {
              host: 'localhost:3000',
              origin: UI_ORIGIN,
              'x-terminal-proxy-capability': CAPABILITY,
            },
          })
        ).status,
      ).toBe(201)
    } finally {
      await service.close()
    }
  })
})

it('describes the actual trading environment as a required fact instead of promising paper execution', async () => {
  const bridge = new BrowserBridge()
  const server = createTradeScriptMcpServer('test-consumer', bridge)
  const client = new Client({ name: 'instructions-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    expect(client.getInstructions()).not.toContain('terminal paper account')
    expect(client.getInstructions()).toContain('executionEnvironment')
  } finally {
    await client.close()
    await server.close()
    bridge.close()
  }
})

it('keeps a bounded120s batch attached beyond the old30s request timeout', async () => {
  vi.useFakeTimers()
  const { bridge, socket, sessionId } = attachedBridge()
  const result = bridge.request(sessionId, 'batch', { sessionId, calls: [] })
  const settled = result.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  try {
    await vi.advanceTimersByTimeAsync(31_000)
    const request = socket.sent.find(({ type }) => type === 'request')
    socket.emit(
      'message',
      JSON.stringify({
        type: 'response',
        id: request?.id,
        result: { stoppedEarly: false, results: [] },
      }),
    )
    expect(await settled).toMatchObject({ value: { stoppedEarly: false } })
    expect(request?.params).toMatchObject({ deadlineAt: expect.any(Number) })
  } finally {
    bridge.close()
  }
})

it('reports a timed-out financial call as outcome unknown rather than definitively failed', async () => {
  vi.useFakeTimers()
  const { bridge, sessionId } = attachedBridge(100)
  const result = bridge
    .request(sessionId, 'call', {
      sessionId,
      controlId: 'trading.placeOrder',
      requestId: 'slow-order',
    })
    .catch((error) => error)
  try {
    await vi.advanceTimersByTimeAsync(101)
    expect(await result).toMatchObject({ code: 'BRIDGE_OUTCOME_UNKNOWN' })
    expect((await result).message).toMatch(/reconcil/i)
  } finally {
    bridge.close()
  }
})

it('reports a disconnected in-flight financial request as outcome unknown', async () => {
  const { bridge, socket, sessionId } = attachedBridge()
  const result = bridge
    .request(sessionId, 'call', { sessionId, controlId: 'trading.placeOrder' })
    .catch((error) => error)
  try {
    socket.close()
    expect(await result).toMatchObject({ code: 'BRIDGE_OUTCOME_UNKNOWN' })
  } finally {
    bridge.close()
  }
})
