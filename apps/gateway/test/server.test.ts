import type { SystemStatusResponse } from '@ibkr-terminal/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { EventStream } from '../src/events/event-stream.js'
import { SessionStore } from '../src/security/session-store.js'
import { WebSocketTicketStore } from '../src/security/websocket-tickets.js'
import { createGatewayServer } from '../src/server.js'

const apps: Array<Awaited<ReturnType<typeof createGatewayServer>>> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function status(): SystemStatusResponse {
  return {
    service: 'ibkr-trading-gateway',
    version: '0.1.0',
    environment: 'paper',
    ready: false,
    tradingEnabled: false,
    generatedAt: new Date(0).toISOString(),
    requirements: [],
  }
}

async function server() {
  const app = await createGatewayServer({
    config: loadGatewayConfig({ NODE_ENV: 'test' }),
    proxyCapability: 'proxy-capability-with-at-least-256-bits-of-entropy',
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: status,
  })
  apps.push(app)
  return app
}

const browserHeaders = {
  host: 'localhost:3000',
  origin: 'http://localhost:3000',
  'sec-fetch-site': 'same-origin',
  'x-terminal-proxy-capability': 'proxy-capability-with-at-least-256-bits-of-entropy',
  'x-tradescript-client': 'terminal-v1',
}

it('exposes safe SDK recovery status and protects authorization retries with session and CSRF checks', async () => {
  const config = loadGatewayConfig({
    NODE_ENV: 'test',
    TRADESCRIPT_CREDENTIAL_ID: 'private-id-fixture',
    TRADESCRIPT_CREDENTIAL_SECRET: 'private-secret-fixture',
    TRADESCRIPT_SDK_VERSION: '0.1.34',
    TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT: 'tsfp1_0123456789abcdef0123456789abcdef',
  })
  const retry = vi.fn(async () => ({ configured: true, ready: true }))
  const renewIfDue = vi.fn()
  const app = await createGatewayServer({
    config,
    proxyCapability: browserHeaders['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: status,
    licensing: {
      config: config.tradescript,
      retry,
      renewIfDue,
      activate: async () => ({ configured: true, ready: true }),
      clearCredentials: () => ({ configured: false, ready: false }),
      snapshot: () => ({ state: 'error', ready: false, failure: 'rejected', message: 'rejected' }),
    },
  })
  apps.push(app)
  expect(
    (
      await app.inject({
        method: 'POST',
        path: '/api/v1/setup/sdk/retry',
        headers: browserHeaders,
        payload: {},
      })
    ).statusCode,
  ).toBe(401)
  const bootstrap = await app.inject({
    method: 'POST',
    path: '/api/v1/session/bootstrap',
    headers: browserHeaders,
    payload: {},
  })
  const cookie = bootstrap.cookies[0]
  const headers = { ...browserHeaders, cookie: `${cookie?.name}=${cookie?.value}` }
  const response = await app.inject({ path: '/api/v1/setup', headers })
  expect(response.statusCode).toBe(200)
  expect(renewIfDue).toHaveBeenCalledTimes(1)
  expect(response.json()).toMatchObject({
    sdk: { configured: true, ready: false, failure: 'rejected' },
  })
  expect(response.body).not.toContain('private-id-fixture')
  expect(response.body).not.toContain('private-secret-fixture')
  expect(
    (await app.inject({ method: 'POST', path: '/api/v1/setup/sdk/retry', headers, payload: {} }))
      .statusCode,
  ).toBe(403)
  expect(retry).not.toHaveBeenCalled()
  expect(
    (
      await app.inject({
        method: 'POST',
        path: '/api/v1/setup/sdk/retry',
        headers: { ...headers, 'x-tradescript-csrf': bootstrap.json().csrfToken },
        payload: {},
      })
    ).statusCode,
  ).toBe(200)
  expect(retry).toHaveBeenCalledTimes(1)
})

describe('gateway HTTP boundary', () => {
  it('exposes only a minimal direct liveness probe', async () => {
    const app = await server()
    const response = await app.inject({ path: '/healthz', headers: { host: '127.0.0.1:3001' } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('rejects direct access and alternate browser origins', async () => {
    const app = await server()
    const direct = await app.inject({
      method: 'POST',
      path: '/api/v1/session/bootstrap',
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-tradescript-client': 'terminal-v1',
      },
      payload: {},
    })
    expect(direct.statusCode).toBe(403)

    const attacker = await app.inject({
      method: 'POST',
      path: '/api/v1/session/bootstrap',
      headers: {
        ...browserHeaders,
        origin: 'http://localhost:3002',
        'content-type': 'application/json',
      },
      payload: {},
    })
    expect(attacker.statusCode).toBe(403)
    expect(attacker.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('issues a strict session and protects mutations with CSRF', async () => {
    const app = await server()
    const bootstrap = await app.inject({
      method: 'POST',
      path: '/api/v1/session/bootstrap',
      headers: { ...browserHeaders, 'content-type': 'application/json' },
      payload: {},
    })
    expect(bootstrap.statusCode).toBe(200)
    const cookie = bootstrap.cookies[0]
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('Strict')
    const csrfToken = bootstrap.json<{ csrfToken: string }>().csrfToken

    const ticket = await app.inject({
      method: 'POST',
      path: '/api/v1/ws-tickets',
      headers: {
        ...browserHeaders,
        'content-type': 'application/json',
        cookie: `${cookie?.name}=${cookie?.value}`,
        'x-tradescript-csrf': csrfToken,
      },
      payload: {},
    })
    expect(ticket.statusCode).toBe(200)
    expect(ticket.json<{ ticket: string }>().ticket.length).toBeGreaterThanOrEqual(43)

    const wrongCsrf = await app.inject({
      method: 'POST',
      path: '/api/v1/ws-tickets',
      headers: {
        ...browserHeaders,
        'content-type': 'application/json',
        cookie: `${cookie?.name}=${cookie?.value}`,
        'x-tradescript-csrf': 'wrong-token',
      },
      payload: {},
    })
    expect(wrongCsrf.statusCode).toBe(403)
  })

  it('serves only the non-secret TradeScript lease to an authenticated browser', async () => {
    const app = await createGatewayServer({
      config: loadGatewayConfig({ NODE_ENV: 'test' }),
      proxyCapability: 'proxy-capability-with-at-least-256-bits-of-entropy',
      sessions: new SessionStore(),
      tickets: new WebSocketTicketStore(),
      events: new EventStream(),
      getStatus: status,
      leases: {
        async getLease() {
          return {
            lease: 'signed-deployment-lease-token-that-is-long-enough-for-contract-validation-0001',
            leaseType: 'TradeScript-Deployment-Lease',
            sdkVersion: '0.1.1',
            customerBuildFingerprint: 'tsfp1_0123456789abcdef0123456789abcdef',
            expiresAt: '2026-09-03T12:00:00.000Z',
            renewAfter: '2026-08-28T00:00:00.000Z',
          }
        },
      },
    })
    apps.push(app)
    const bootstrap = await app.inject({
      method: 'POST',
      path: '/api/v1/session/bootstrap',
      headers: { ...browserHeaders, 'content-type': 'application/json' },
      payload: {},
    })
    const cookie = bootstrap.cookies[0]
    const response = await app.inject({
      method: 'GET',
      path: '/api/v1/tradescript/bootstrap',
      headers: { ...browserHeaders, cookie: `${cookie?.name}=${cookie?.value}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).not.toHaveProperty('credentialId')
    expect(response.json()).not.toHaveProperty('credentialSecret')
  })
})

it('serves and switches connection profiles through authenticated HTTP', async () => {
  const { ConnectionManager } = await import('../src/connections/connection-manager.js')
  const connections = new ConnectionManager(loadGatewayConfig({ NODE_ENV: 'test' }), () => ({
    start() {},
    stop() {},
  }))
  const app = await createGatewayServer({
    get config() {
      return connections.config
    },
    connections,
    proxyCapability: browserHeaders['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: status,
  })
  apps.push(app)
  const bootstrap = await app.inject({
    method: 'POST',
    path: '/api/v1/session/bootstrap',
    headers: { ...browserHeaders, 'content-type': 'application/json' },
    payload: {},
  })
  const cookie = String(bootstrap.headers['set-cookie']).split(';')[0]!
  const headers = {
    ...browserHeaders,
    cookie,
    'content-type': 'application/json',
    'x-tradescript-csrf': bootstrap.json().csrfToken,
  }
  const current = await app.inject({ path: '/api/v1/connection', headers })
  expect(current.statusCode).toBe(200)
  const snapshot = current.json()
  snapshot.settings.active = 'live'
  snapshot.settings.profiles.live.port = 4014
  snapshot.settings.profiles.live.permission = 'manual'
  const changed = await app.inject({
    method: 'PUT',
    path: '/api/v1/connection',
    headers,
    payload: snapshot,
  })
  expect(changed.statusCode).toBe(200)
  expect(connections.config.ibkr).toMatchObject({
    port: 4014,
    executionEnvironment: 'live',
    tradingEnabled: true,
  })
  expect(
    (await app.inject({ method: 'PUT', path: '/api/v1/connection', headers, payload: snapshot }))
      .statusCode,
  ).toBe(409)
  expect(
    (
      await app.inject({
        method: 'PUT',
        path: '/api/v1/connection',
        headers: { ...headers, 'x-tradescript-csrf': 'invalid' },
        payload: changed.json(),
      })
    ).statusCode,
  ).toBe(403)
})

it('dispatches to the active broker and applies profile permissions and session generations', async () => {
  const { ConnectionManager } = await import('../src/connections/connection-manager.js')
  const { BrokerStateStore } = await import('../src/ibkr/state-store.js')
  let placements = 0
  const connections = new ConnectionManager(loadGatewayConfig({ NODE_ENV: 'test' }), () => ({
    start() {},
    stop() {},
    brokerStore: new BrokerStateStore(),
    ibkr: {
      async placeOrder() {
        placements += 1
        return { id: 'synthetic-order' }
      },
    } as unknown as import('../src/ibkr/ibkr-service.js').IbkrService,
  }))
  const app = await createGatewayServer({
    get config() {
      return connections.config
    },
    connections,
    get ibkr() {
      return connections.runtime.ibkr
    },
    get brokerStore() {
      return connections.runtime.brokerStore
    },
    proxyCapability: browserHeaders['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: () => ({
      ...status(),
      ready: true,
      environment: connections.config.ibkr.executionEnvironment,
      tradingEnabled: connections.config.ibkr.tradingEnabled ?? false,
    }),
  })
  apps.push(app)
  const bootstrap = await app.inject({
    method: 'POST',
    path: '/api/v1/session/bootstrap',
    headers: { ...browserHeaders, 'content-type': 'application/json' },
    payload: {},
  })
  const headers = {
    ...browserHeaders,
    cookie: String(bootstrap.headers['set-cookie']).split(';')[0]!,
    'content-type': 'application/json',
    'x-tradescript-csrf': bootstrap.json().csrfToken,
    'x-tradescript-connection': connections.snapshot().generation,
  }
  const order = {
    expectedExecutionEnvironment: 'paper',
    draft: {
      symbol: { symbol: 'TEST' },
      side: 'buy',
      type: 'limit',
      quantity: 1,
      limitPrice: 1,
      duration: 'day',
    },
  }
  expect(
    (await app.inject({ method: 'POST', path: '/api/v1/ibkr/orders', headers, payload: order }))
      .statusCode,
  ).toBe(201)
  expect(
    (
      await app.inject({
        method: 'POST',
        path: '/api/v1/ibkr/orders',
        headers,
        payload: { ...order, metadata: { origin: 'mcp' } },
      })
    ).statusCode,
  ).toBe(403)
  const snapshot = connections.snapshot()
  snapshot.settings.active = 'live'
  snapshot.settings.profiles.live.permission = 'manual'
  snapshot.settings.profiles.live.port = 4020
  await connections.switch(snapshot.settings, snapshot.generation)
  const health = await app.inject({ path: '/api/v1/ibkr/health', headers })
  expect(health.json()).toMatchObject({ mode: 'live', ibkrPort: 4020 })
  expect(
    (await app.inject({ method: 'POST', path: '/api/v1/ibkr/orders', headers, payload: order }))
      .statusCode,
  ).toBe(409)
  const current = connections.snapshot()
  current.settings.profiles.live.permission = 'read-only'
  const readOnly = await connections.switch(current.settings, current.generation)
  expect(
    (
      await app.inject({
        method: 'POST',
        path: '/api/v1/ibkr/orders',
        headers: { ...headers, 'x-tradescript-connection': readOnly.generation },
        payload: { ...order, expectedExecutionEnvironment: 'live' },
      })
    ).statusCode,
  ).toBe(503)
  expect(placements).toBe(1)
})
