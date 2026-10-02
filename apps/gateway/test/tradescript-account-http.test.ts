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
const accountId = '8dc43b3e-8c46-4c0a-a51e-cfe383a45762'

it('protects account login, syncing, and logout with the existing same-origin session and CSRF authority', async () => {
  const account = {
    snapshot: vi.fn(() => ({ state: 'signed-out' as const })),
    login: vi.fn(async () => ({
      url: 'https://console.tradescript.dev/login?mode=trader&native=1',
    })),
    sync: vi.fn(async () => ({ state: 'signed-in' as const })),
    logout: vi.fn(() => ({ state: 'signed-out' as const })),
    purchaseURL: () => 'https://console.tradescript.dev/login?mode=trader&plan=individual',
  }
  const config = loadGatewayConfig({ NODE_ENV: 'test' })
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
    account,
  })
  apps.push(app)
  for (const action of ['login', 'sync', 'logout']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/setup/account/${action}`,
      headers,
      payload: {},
    })
    expect(response.statusCode).toBe(401)
  }
  expect(account.login).not.toHaveBeenCalled()
  expect(account.sync).not.toHaveBeenCalled()
  expect(account.logout).not.toHaveBeenCalled()
  const bootstrap = await app.inject({
    method: 'POST',
    url: '/api/v1/session/bootstrap',
    headers,
    payload: {},
  })
  const cookie = bootstrap.cookies[0]
  if (!cookie) throw new Error('Missing fixture browser session')
  const authenticated = { ...headers, cookie: `${cookie.name}=${cookie.value}` }
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/v1/setup/account/logout',
    headers: authenticated,
    payload: {},
  })
  expect(rejected.statusCode).toBe(403)
  expect(account.logout).not.toHaveBeenCalled()
  const trusted = { ...authenticated, 'x-tradescript-csrf': bootstrap.json().csrfToken }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/setup/account/login',
        headers: trusted,
        payload: {},
      })
    ).statusCode,
  ).toBe(200)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/setup/account/sync',
        headers: trusted,
        payload: { accountId },
      })
    ).statusCode,
  ).toBe(200)
  expect(account.sync).toHaveBeenCalledWith(accountId)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/setup/account/sync',
        headers: trusted,
        payload: { accountId: 'invalid' },
      })
    ).statusCode,
  ).toBe(400)
  expect(account.sync).toHaveBeenCalledOnce()
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/setup/account/logout',
        headers: trusted,
        payload: {},
      })
    ).statusCode,
  ).toBe(200)
  expect(account.logout).toHaveBeenCalledOnce()
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/setup/account/purchase',
        headers: authenticated,
      })
    ).json(),
  ).toEqual({ url: account.purchaseURL() })
  expect(config.ibkr).toEqual(loadGatewayConfig({ NODE_ENV: 'test' }).ibkr)
})
