import { afterEach, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { EventStream } from '../src/events/event-stream.js'
import { SessionStore } from '../src/security/session-store.js'
import { WebSocketTicketStore } from '../src/security/websocket-tickets.js'
import { createGatewayServer } from '../src/server.js'

const apps: Awaited<ReturnType<typeof createGatewayServer>>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})
const headers = {
  host: 'localhost:3000',
  origin: 'http://localhost:3000',
  'sec-fetch-site': 'same-origin',
  'x-terminal-proxy-capability': 'fixture-proxy',
  'x-tradescript-client': 'terminal-v1',
  'content-type': 'application/json',
}

async function fixture() {
  const config = loadGatewayConfig({ NODE_ENV: 'test' })
  const licensing = {
    config: config.tradescript,
    snapshot: vi.fn(() => ({ state: 'unconfigured' as const, ready: false, message: 'Fixture' })),
    renewIfDue: vi.fn(),
    activate: vi.fn(async () => ({ configured: true, ready: true })),
    retry: vi.fn(async () => ({ configured: true, ready: true })),
    clearCredentials: vi.fn(() => ({ configured: false, ready: false })),
  }
  const app = await createGatewayServer({
    config,
    proxyCapability: headers['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: () => ({
      service: 'ibkr-trading-gateway',
      version: 'fixture',
      environment: 'paper',
      ready: false,
      tradingEnabled: false,
      generatedAt: new Date(0).toISOString(),
      requirements: [],
    }),
    licensing,
  })
  apps.push(app)
  const bootstrap = await app.inject({
    method: 'POST',
    url: '/api/v1/session/bootstrap',
    headers,
    payload: {},
  })
  const cookie = bootstrap.cookies[0]
  if (!cookie) throw new Error('Missing fixture browser session')
  const authenticated = { ...headers, cookie: `${cookie.name}=${cookie.value}` }
  const trusted = { ...authenticated, 'x-tradescript-csrf': bootstrap.json().csrfToken }
  return { app, config, licensing, authenticated, trusted }
}

it('clears SDK credentials only with the existing same-origin session and CSRF authority', async () => {
  const item = await fixture()
  for (const [requestHeaders, status] of [
    [headers, 401],
    [item.authenticated, 403],
  ] as const) {
    const response = await item.app.inject({
      method: 'DELETE',
      url: '/api/v1/setup/sdk',
      headers: requestHeaders,
      payload: {},
    })
    expect(response.statusCode).toBe(status)
  }
  expect(item.licensing.clearCredentials).not.toHaveBeenCalled()
  const response = await item.app.inject({
    method: 'DELETE',
    url: '/api/v1/setup/sdk',
    headers: item.trusted,
    payload: {},
  })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ configured: false, ready: false })
  expect(item.licensing.clearCredentials).toHaveBeenCalledOnce()
  expect(item.config.ibkr).toEqual(loadGatewayConfig({ NODE_ENV: 'test' }).ibkr)
})

it('exposes SDK setup without a console account contract or account routes', async () => {
  const item = await fixture()
  const setup = await item.app.inject({
    method: 'GET',
    url: '/api/v1/setup',
    headers: item.authenticated,
  })
  expect(setup.statusCode).toBe(200)
  expect(setup.json()).not.toHaveProperty('account')
  expect(setup.json().sdk).not.toHaveProperty('credentialSecret')
  for (const action of ['login', 'sync', 'logout', 'mfa', 'purchase']) {
    const response = await item.app.inject({
      method: action === 'purchase' ? 'GET' : 'POST',
      url: `/api/v1/setup/account/${action}`,
      headers: item.trusted,
      ...(action === 'purchase' ? {} : { payload: {} }),
    })
    expect(response.statusCode).toBe(404)
  }
})
