import { afterEach, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { ConnectionManager } from '../src/connections/connection-manager.js'
import { EventStream } from '../src/events/event-stream.js'
import { SessionStore } from '../src/security/session-store.js'
import { WebSocketTicketStore } from '../src/security/websocket-tickets.js'
import { createGatewayServer } from '../src/server.js'

const apps: Array<Awaited<ReturnType<typeof createGatewayServer>>> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const headers = {
  host: 'localhost:3000',
  origin: 'http://localhost:3000',
  'sec-fetch-site': 'same-origin',
  'x-terminal-proxy-capability': 'test-proxy-capability',
  'x-tradescript-client': 'terminal-v1',
  'content-type': 'application/json',
}

it('protects connection retries and resumes only the existing connection generation', async () => {
  const retryConnection = vi.fn()
  const connections = new ConnectionManager(loadGatewayConfig({ NODE_ENV: 'test' }), () => ({
    start() {},
    stop() {},
    retryConnection,
  }))
  const before = connections.snapshot()
  const app = await createGatewayServer({
    config: connections.config,
    connections,
    proxyCapability: headers['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: () => ({
      service: 'ibkr-trading-gateway',
      version: 'test',
      environment: 'paper',
      ready: false,
      tradingEnabled: false,
      generatedAt: new Date().toISOString(),
      requirements: [],
    }),
  })
  apps.push(app)
  const payload = { generation: before.generation }
  const send = (requestHeaders: Record<string, string>, body: unknown = payload) =>
    app.inject({
      method: 'POST',
      path: '/api/v1/connection/retry',
      headers: requestHeaders,
      payload: body,
    })
  expect((await send(headers)).statusCode).toBe(401)
  const bootstrap = await app.inject({
    method: 'POST',
    path: '/api/v1/session/bootstrap',
    headers,
    payload: {},
  })
  const authenticated = {
    ...headers,
    cookie: String(bootstrap.headers['set-cookie']).split(';')[0] ?? '',
    'x-tradescript-csrf': bootstrap.json().csrfToken,
  }
  expect((await send({ ...authenticated, 'x-tradescript-csrf': 'invalid' })).statusCode).toBe(403)
  expect((await send(authenticated, { generation: '' })).statusCode).toBe(400)
  expect((await send(authenticated, { generation: 'old-generation' })).statusCode).toBe(409)
  expect(retryConnection).not.toHaveBeenCalled()
  const result = await send(authenticated)
  expect(result.statusCode).toBe(200)
  expect(result.json()).toEqual(before)
  expect(retryConnection).toHaveBeenCalledOnce()
  expect(connections.snapshot()).toEqual(before)
})
