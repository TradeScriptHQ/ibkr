import type { ConnectionSnapshot, SystemStatusResponse } from '@ibkr-terminal/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { EventStream } from '../src/events/event-stream.js'
import { MarketDataError, RequestError } from '../src/ibkr/request-error.js'
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

const agentLimits = {
  maxOrderQuantity: 100,
  maxOrderNotional: 1000,
  maxPositionQuantity: 100,
  maxPositionNotional: 1000,
  maxDailyLoss: 100,
  maxOrdersPerMinute: 10,
  maxEstimatedSlippageBps: 10,
  maxMarketDataAgeMs: 1000,
  maxLeverage: 2,
  maxUnprotectedPositionQuantity: 100,
}

async function authenticatedHeaders(app: Awaited<ReturnType<typeof createGatewayServer>>) {
  const bootstrap = await app.inject({
    method: 'POST',
    path: '/api/v1/session/bootstrap',
    headers: browserHeaders,
    payload: {},
  })
  return {
    ...browserHeaders,
    cookie: String(bootstrap.headers['set-cookie']).split(';')[0]!,
    'content-type': 'application/json',
    'x-tradescript-csrf': bootstrap.json().csrfToken,
  }
}

it('protects the direct agent trading toggle with authentication, CSRF, input validation and connection generation', async () => {
  const { ConnectionManager } = await import('../src/connections/connection-manager.js')
  const connections = new ConnectionManager(
    loadGatewayConfig({ NODE_ENV: 'test', IBKR_ALLOWED_ACCOUNT_IDS: 'DU-test' }),
    () => ({ start() {}, stop() {} }),
  )
  const setAgentTrading = vi.spyOn(connections, 'setAgentTrading')
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
  const payload = {
    enabled: true,
    generation: connections.snapshot().generation,
    expectedAgentTradingRevision: 0,
    limits: agentLimits,
  }
  expect(
    (
      await app.inject({
        method: 'PUT',
        path: '/api/v1/connection/agent-trading',
        headers: browserHeaders,
        payload,
      })
    ).statusCode,
  ).toBe(401)
  const headers = await authenticatedHeaders(app)
  expect(
    (
      await app.inject({
        method: 'PUT',
        path: '/api/v1/connection/agent-trading',
        headers: { ...headers, 'x-tradescript-csrf': 'invalid' },
        payload,
      })
    ).statusCode,
  ).toBe(403)
  for (const invalid of [
    { ...payload, enabled: 'yes' },
    { ...payload, generation: '' },
    { ...payload, expectedAgentTradingRevision: undefined },
    { ...payload, expectedAgentTradingRevision: -1 },
    { ...payload, expectedAgentTradingRevision: 0.5 },
    { ...payload, limits: { ...agentLimits, maxOrderQuantity: -1 } },
  ]) {
    expect(
      (
        await app.inject({
          method: 'PUT',
          path: '/api/v1/connection/agent-trading',
          headers,
          payload: invalid,
        })
      ).statusCode,
    ).toBe(400)
  }
  expect(setAgentTrading).not.toHaveBeenCalled()
  expect(
    (
      await app.inject({
        method: 'PUT',
        path: '/api/v1/connection/agent-trading',
        headers,
        payload: { ...payload, generation: 'stale' },
      })
    ).statusCode,
  ).toBe(409)
  expect(connections.config.agents.enabled).toBe(false)
})

it('saves agent limits and toggles agent authority without reconnecting, publishing the updated readiness', async () => {
  const { ConnectionManager } = await import('../src/connections/connection-manager.js')
  const factory = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }))
  const connections = new ConnectionManager(
    loadGatewayConfig({ NODE_ENV: 'test', IBKR_ALLOWED_ACCOUNT_IDS: 'DU-test' }),
    factory,
  )
  const original = connections.runtime
  const generation = connections.snapshot().generation
  const events = new EventStream()
  const published = vi.fn()
  events.subscribe(published)
  const app = await createGatewayServer({
    get config() {
      return connections.config
    },
    connections,
    proxyCapability: browserHeaders['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events,
    getStatus: () => ({
      ...status(),
      ready: true,
      tradingEnabled: true,
      requirements: [
        {
          id: 'agent-risk',
          label: 'Agent trading',
          state: connections.config.agents.enabled ? 'ready' : 'disabled',
          message: 'Current agent permission',
          requiredForTrading: false,
        },
      ],
    }),
  })
  apps.push(app)
  const headers = await authenticatedHeaders(app)
  const update = (payload: object) =>
    app.inject({
      method: 'PUT',
      path: '/api/v1/connection/agent-trading',
      headers,
      payload: {
        expectedAgentTradingRevision: connections.snapshot().agentTradingRevision,
        ...payload,
      },
    })
  expect((await update({ enabled: true, generation })).statusCode).toBe(400)
  expect(published).not.toHaveBeenCalled()
  const saved = await update({ enabled: false, generation, limits: agentLimits })
  expect(saved.statusCode).toBe(200)
  expect(saved.json()).toMatchObject({
    generation,
    settings: { profiles: { paper: { agentTradingEnabled: false, limits: agentLimits } } },
  })
  const enabled = await update({ enabled: true, generation })
  expect(enabled.statusCode).toBe(200)
  expect(connections.config.agents).toMatchObject({ enabled: true, riskLimits: agentLimits })
  expect(published.mock.calls.at(-1)?.[0]).toMatchObject({
    event: {
      type: 'readiness.changed',
      status: { requirements: [{ id: 'agent-risk', state: 'ready' }] },
    },
  })
  const staleSave = await update({
    enabled: false,
    generation,
    limits: { ...agentLimits, maxOrderQuantity: 200 },
    expectedAgentTradingRevision: saved.json().agentTradingRevision,
  })
  expect(staleSave.statusCode).toBe(409)
  expect(staleSave.json().error.message).toContain('Agent trading settings changed')
  expect(connections.config.agents).toMatchObject({ enabled: true, riskLimits: agentLimits })
  expect((await update({ enabled: false, generation })).statusCode).toBe(200)
  expect(connections.config.agents.enabled).toBe(false)
  expect(connections.config.ibkr.tradingEnabled).toBe(true)
  expect(connections.snapshot().generation).toBe(generation)
  expect(connections.runtime).toBe(original)
  expect(factory).toHaveBeenCalledOnce()
  expect(original.start).not.toHaveBeenCalled()
  expect(original.stop).not.toHaveBeenCalled()
  expect(published).toHaveBeenCalledTimes(3)
})

it('reports typed market-data causes for chart history and a competing live session in health', async () => {
  const { BrokerStateStore } = await import('../src/ibkr/state-store.js')
  const brokerStore = new BrokerStateStore()
  brokerStore.setConnectionStatus('connected')
  const message =
    "IBKR sent no chart history for AAPL while it reports that another session is using this account's live market data (IBKR 10197)."
  const app = await createGatewayServer({
    config: loadGatewayConfig({ NODE_ENV: 'test' }),
    ibkr: {
      loadBars: vi.fn(async () => {
        throw new MarketDataError(503, 'market-data-competing-session', message)
      }),
      competingLiveSessionReported: () => true,
    } as unknown as import('../src/ibkr/ibkr-service.js').IbkrService,
    brokerStore,
    proxyCapability: browserHeaders['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: status,
  })
  apps.push(app)
  const headers = await authenticatedHeaders(app)
  const bars = await app.inject({
    path: '/api/v1/ibkr/bars?symbol=AAPL&interval=5m&barCount=500',
    headers,
  })
  expect(bars.statusCode).toBe(503)
  expect(bars.json().error).toMatchObject({ code: 'market-data-competing-session', message })
  const health = await app.inject({ path: '/api/v1/ibkr/health', headers })
  expect(health.json()).toMatchObject({ connectionStatus: 'connected', competingLiveSession: true })
})

it('passes each requested sparkline symbol with the shared contract metadata to IBKR', async () => {
  const { BrokerStateStore } = await import('../src/ibkr/state-store.js')
  const brokerStore = new BrokerStateStore()
  brokerStore.setConnectionStatus('connected')
  const getSparklines = vi.fn(async (symbols: Array<{ symbol: string }>) =>
    symbols.map((symbol) => ({ symbol, values: [1, 2] })),
  )
  const app = await createGatewayServer({
    config: loadGatewayConfig({ NODE_ENV: 'test' }),
    ibkr: { getSparklines } as unknown as import('../src/ibkr/ibkr-service.js').IbkrService,
    brokerStore,
    proxyCapability: browserHeaders['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: status,
  })
  apps.push(app)
  const headers = await authenticatedHeaders(app)
  const response = await app.inject({
    path: '/api/v1/ibkr/sparklines?symbol=AAPL&symbol=MSFT&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock',
    headers,
  })
  expect(response.statusCode).toBe(200)
  const metadata = {
    exchange: 'SMART',
    primaryExchange: 'NASDAQ',
    currency: 'USD',
    assetClass: 'stock',
  }
  expect(getSparklines).toHaveBeenCalledWith([
    { symbol: 'AAPL', ...metadata },
    { symbol: 'MSFT', ...metadata },
  ])
  expect(response.json()).toEqual([
    { symbol: { symbol: 'AAPL', ...metadata }, values: [1, 2] },
    { symbol: { symbol: 'MSFT', ...metadata }, values: [1, 2] },
  ])
})

it('rechecks agent authority inside execution when it changes after the early request check', async () => {
  const { ConnectionManager } = await import('../src/connections/connection-manager.js')
  const { BrokerStateStore } = await import('../src/ibkr/state-store.js')
  const config = loadGatewayConfig({ NODE_ENV: 'test', IBKR_ALLOWED_ACCOUNT_IDS: 'DU-test' })
  const snapshot = new ConnectionManager(config, () => ({ start() {}, stop() {} })).snapshot()
  let agentsEnabled = true
  let release!: () => void
  let entered!: () => void
  const executing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const placeOrder = vi.fn(async () => ({ id: 'synthetic-order' }))
  const app = await createGatewayServer({
    get config() {
      return { ...config, agents: { ...config.agents, enabled: agentsEnabled } }
    },
    connections: {
      snapshot: () => snapshot,
      switch: async () => snapshot,
      setAgentTrading: async (enabled): Promise<ConnectionSnapshot> => {
        agentsEnabled = enabled
        return snapshot
      },
      execute: async (_generation, execute) => {
        entered()
        await gate
        return execute()
      },
    },
    ibkr: { placeOrder } as unknown as import('../src/ibkr/ibkr-service.js').IbkrService,
    brokerStore: new BrokerStateStore(),
    proxyCapability: browserHeaders['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: () => ({ ...status(), ready: true, tradingEnabled: true }),
  })
  apps.push(app)
  const headers = await authenticatedHeaders(app)
  const pending = app.inject({
    method: 'POST',
    path: '/api/v1/ibkr/orders',
    headers: { ...headers, 'x-tradescript-connection': snapshot.generation },
    payload: {
      expectedExecutionEnvironment: 'paper',
      draft: {
        accountId: 'DU-test',
        symbol: { symbol: 'TEST' },
        side: 'buy',
        type: 'limit',
        quantity: 1,
        limitPrice: 1,
        duration: 'day',
      },
      metadata: { origin: 'mcp' },
    },
  })
  await executing
  const disabled = await app.inject({
    method: 'PUT',
    path: '/api/v1/connection/agent-trading',
    headers,
    payload: {
      enabled: false,
      generation: snapshot.generation,
      expectedAgentTradingRevision: snapshot.agentTradingRevision,
    },
  })
  expect(disabled.statusCode).toBe(200)
  release()
  const response = await pending
  expect(response.statusCode).toBe(403)
  expect(response.json().error.message).toBe('Agent trading is disabled for this connection.')
  expect(placeOrder).not.toHaveBeenCalled()
})

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
      snapshot: () => ({
        state: 'error',
        ready: false,
        failure: 'rejected',
        failureReason: 'trial_access_expired',
        message:
          'Your seven-day free trial access has ended. Activate a subscription with your existing credentials.',
      }),
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
    sdk: {
      configured: true,
      ready: false,
      failure: 'rejected',
      failureReason: 'trial_access_expired',
      message:
        'Your seven-day free trial access has ended. Activate a subscription with your existing credentials.',
    },
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
  retry.mockImplementationOnce(async () => {
    throw new RequestError(401, 'Runtime credentials were rejected.', {
      source: 'tradescript-authorization',
      code: 'unauthorized',
    })
  })
  const upstreamRejection = await app.inject({
    method: 'POST',
    path: '/api/v1/setup/sdk/retry',
    headers: { ...headers, 'x-tradescript-csrf': bootstrap.json().csrfToken },
    payload: {},
  })
  expect(upstreamRejection.statusCode).toBe(401)
  expect(upstreamRejection.json()).toMatchObject({
    error: {
      code: 'unauthorized',
      source: 'tradescript-authorization',
      message: 'Runtime credentials were rejected.',
    },
  })
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
  const connections = new ConnectionManager(
    loadGatewayConfig({ NODE_ENV: 'test' }),
    () => ({
      start() {},
      stop() {},
    }),
    undefined,
    async () => ['U-test'],
  )
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
  expect(
    (await app.inject({ method: 'PUT', path: '/api/v1/connection', headers, payload: snapshot }))
      .statusCode,
  ).toBe(409)
  const proof = await app.inject({
    method: 'POST',
    path: '/api/v1/connection/test',
    headers,
    payload: snapshot,
  })
  expect(proof.statusCode).toBe(200)
  const changed = await app.inject({
    method: 'PUT',
    path: '/api/v1/connection',
    headers,
    payload: { ...snapshot, testId: proof.json().testId },
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

it('dispatches manual trades to the active broker and rejects stale session generations and disabled agents', async () => {
  const { ConnectionManager } = await import('../src/connections/connection-manager.js')
  const { BrokerStateStore } = await import('../src/ibkr/state-store.js')
  let placements = 0
  const connections = new ConnectionManager(
    loadGatewayConfig({ NODE_ENV: 'test' }),
    () => ({
      start() {},
      stop() {},
      brokerStore: new BrokerStateStore(),
      ibkr: {
        async placeOrder() {
          placements += 1
          return { id: 'synthetic-order' }
        },
        competingLiveSessionReported: () => false,
      } as unknown as import('../src/ibkr/ibkr-service.js').IbkrService,
    }),
    undefined,
    async () => ['U-test'],
  )
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
  snapshot.settings.profiles.live.port = 4020
  snapshot.settings.profiles.live.connectionType = 'ib-gateway'
  const liveTest = await connections.test(snapshot.settings, snapshot.generation)
  await connections.switch(snapshot.settings, snapshot.generation, liveTest.testId)
  const health = await app.inject({ path: '/api/v1/ibkr/health', headers })
  expect(health.json()).toMatchObject({
    mode: 'live',
    connectionType: 'ib-gateway',
    ibkrPort: 4020,
  })
  expect(
    (await app.inject({ method: 'POST', path: '/api/v1/ibkr/orders', headers, payload: order }))
      .statusCode,
  ).toBe(409)
  const current = connections.snapshot()
  expect(
    (
      await app.inject({
        method: 'POST',
        path: '/api/v1/ibkr/orders',
        headers: { ...headers, 'x-tradescript-connection': current.generation },
        payload: { ...order, expectedExecutionEnvironment: 'live' },
      })
    ).statusCode,
  ).toBe(201)
  expect(placements).toBe(2)
})

it('passes numeric tape history bounds to the bridge and ignores malformed ones', async () => {
  const { BrokerStateStore } = await import('../src/ibkr/state-store.js')
  const brokerStore = new BrokerStateStore()
  brokerStore.setConnectionStatus('connected')
  const getTimeAndSales = vi.fn(() => [])
  const app = await createGatewayServer({
    config: loadGatewayConfig({ NODE_ENV: 'test' }),
    ibkr: { getTimeAndSales } as unknown as import('../src/ibkr/ibkr-service.js').IbkrService,
    brokerStore,
    proxyCapability: browserHeaders['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    getStatus: status,
  })
  apps.push(app)
  const headers = await authenticatedHeaders(app)
  const response = await app.inject({
    path: '/api/v1/ibkr/time-and-sales?symbol=AAPL&limit=500&startTime=1790000000000&endTime=1790000060000&beforeSequence=abc',
    headers,
  })
  expect(response.statusCode).toBe(200)
  expect(getTimeAndSales).toHaveBeenCalledWith(
    expect.objectContaining({ symbol: 'AAPL' }),
    500,
    undefined,
    { startTime: 1_790_000_000_000, endTime: 1_790_000_060_000, beforeSequence: undefined },
  )
})
