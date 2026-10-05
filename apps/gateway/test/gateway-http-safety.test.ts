import { afterEach, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { EventStream } from '../src/events/event-stream.js'
import type { IbkrService } from '../src/ibkr/ibkr-service.js'
import { RequestError } from '../src/ibkr/request-error.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import { SessionStore } from '../src/security/session-store.js'
import { WebSocketTicketStore } from '../src/security/websocket-tickets.js'
import { createGatewayServer } from '../src/server.js'

const apps: Array<Awaited<ReturnType<typeof createGatewayServer>>> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})
const browserHeaders = {
  host: 'localhost:3000',
  origin: 'http://localhost:3000',
  'sec-fetch-site': 'same-origin',
  'x-terminal-proxy-capability': 'test-only-proxy-capability',
  'x-tradescript-client': 'terminal-v1',
}
async function fixture(options: { readOnly?: boolean; agents?: boolean } = {}) {
  const config = loadGatewayConfig({ NODE_ENV: 'test' })
  config.agents.enabled = options.agents ?? false
  config.ibkr.tradingEnabled = !options.readOnly
  const ibkr = {
    closePosition: vi.fn(async () => ({ id: 'close-test-order' })),
    placeOrder: vi.fn(async () => ({ id: 'test-order' })),
    setActiveAccount: vi.fn(async () => ({ activeAccountId: 'DU1234567' })),
    resolveOptionContract: vi.fn(async () => ({ brokerContractId: 123 })),
    previewOrder: vi.fn(async () => ({ warnings: [] })),
    previewModifyOrder: vi.fn(async () => ({ warnings: [] })),
    previewClosePosition: vi.fn(async () => ({ warnings: [] })),
  }
  const appendJournal = vi.fn()
  const onAuditUnavailable = vi.fn()
  const app = await createGatewayServer({
    config,
    proxyCapability: browserHeaders['x-terminal-proxy-capability'],
    sessions: new SessionStore(),
    tickets: new WebSocketTicketStore(),
    events: new EventStream(),
    brokerStore: new BrokerStateStore(),
    ibkr: ibkr as unknown as IbkrService,
    database: { appendJournal },
    onAuditUnavailable,
    getStatus: () => ({
      service: 'ibkr-trading-gateway',
      version: '0.1.0',
      environment: 'paper',
      ready: true,
      tradingEnabled: !options.readOnly,
      generatedAt: new Date(0).toISOString(),
      requirements: [],
    }),
  })
  apps.push(app)
  const bootstrap = await app.inject({
    method: 'POST',
    path: '/api/v1/session/bootstrap',
    headers: browserHeaders,
    payload: {},
  })
  const headers = {
    ...browserHeaders,
    cookie: String(bootstrap.headers['set-cookie']).split(';')[0]!,
    'x-tradescript-csrf': bootstrap.json().csrfToken,
  }
  return { app, ibkr, appendJournal, onAuditUnavailable, headers, bootstrap }
}
const place = { expectedExecutionEnvironment: 'paper', draft: { quantity: 1 } }

it('rejects agent closes using SDK financial options when agent trading is disabled', async () => {
  const { app, headers, ibkr, appendJournal } = await fixture()
  const response = await app.inject({
    method: 'POST',
    path: '/api/v1/ibkr/positions/test-position/close',
    headers,
    payload: {
      expectedExecutionEnvironment: 'paper',
      options: { origin: 'mcp', operationId: 'agent-close' },
    },
  })
  expect(response.statusCode).toBe(403)
  expect(ibkr.closePosition).not.toHaveBeenCalled()
  expect(appendJournal).not.toHaveBeenCalled()
})

it.each(['mcp', 'host'] as const)(
  'attributes %s closes with their operation identity',
  async (origin) => {
    const { app, headers, appendJournal } = await fixture({ agents: true })
    const response = await app.inject({
      method: 'POST',
      path: '/api/v1/ibkr/positions/test-position/close',
      headers,
      payload: {
        expectedExecutionEnvironment: 'paper',
        options: { origin, operationId: 'close-operation' },
      },
    })
    expect(response.statusCode).toBe(201)
    expect(appendJournal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: 'position.close.succeeded',
        actorType: origin === 'mcp' ? 'agent' : 'host',
        correlationId: 'close-operation',
      }),
    )
  },
)

it('rejects conflicting operation origins before contacting the broker', async () => {
  const { app, headers, ibkr } = await fixture()
  const response = await app.inject({
    method: 'POST',
    path: '/api/v1/ibkr/positions/test-position/close',
    headers,
    payload: {
      expectedExecutionEnvironment: 'paper',
      metadata: { origin: 'human' },
      options: { origin: 'mcp' },
    },
  })
  expect(response.statusCode).toBe(400)
  expect(ibkr.closePosition).not.toHaveBeenCalled()
})

it('returns an accepted broker result when its success journal fails, then blocks further mutations', async () => {
  const { app, headers, ibkr, appendJournal, onAuditUnavailable } = await fixture()
  appendJournal.mockImplementation((entry) => {
    if (entry.eventType.endsWith('.succeeded')) throw new Error('test-only ledger unavailable')
  })
  const response = await app.inject({
    method: 'POST',
    path: '/api/v1/ibkr/orders',
    headers,
    payload: place,
  })
  expect(response.statusCode).toBe(201)
  expect(response.json()).toEqual({ id: 'test-order' })
  expect(appendJournal.mock.calls.map(([entry]) => entry.eventType)).toEqual([
    'order.place.attempted',
    'order.place.succeeded',
  ])
  expect(onAuditUnavailable).toHaveBeenCalledOnce()
  expect(
    (await app.inject({ method: 'POST', path: '/api/v1/ibkr/orders', headers, payload: place }))
      .statusCode,
  ).toBe(503)
  expect(ibkr.placeOrder).toHaveBeenCalledOnce()
})

it('never masks a broker error with a failed failure-journal write', async () => {
  const { app, headers, ibkr, appendJournal } = await fixture()
  ibkr.placeOrder.mockRejectedValue(new RequestError(409, 'test-only broker conflict'))
  appendJournal.mockImplementation((entry) => {
    if (entry.eventType.endsWith('.failed')) throw new Error('test-only journal failure')
  })
  const response = await app.inject({
    method: 'POST',
    path: '/api/v1/ibkr/orders',
    headers,
    payload: place,
  })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.message).toBe('test-only broker conflict')
})

it('blocks broker transmission when the attempted journal cannot be written', async () => {
  const { app, headers, ibkr, appendJournal } = await fixture()
  appendJournal.mockImplementation(() => {
    throw new Error('test-only journal failure')
  })
  expect(
    (await app.inject({ method: 'POST', path: '/api/v1/ibkr/orders', headers, payload: place }))
      .statusCode,
  ).toBe(503)
  expect(ibkr.placeOrder).not.toHaveBeenCalled()
})

it.each([
  ['/api/v1/ibkr/accounts/DU1234567/activate', {}],
  ['/api/v1/ibkr/options/resolve', { contract: {} }],
  ['/api/v1/ibkr/orders/preview', { draft: {} }],
  ['/api/v1/ibkr/orders/test-order/preview', { patch: {} }],
  ['/api/v1/ibkr/positions/test-position/close/preview', {}],
])(
  'allows ready read-only profiles to inspect %s while order transmission stays locked',
  async (path, payload) => {
    const { app, headers, ibkr } = await fixture({ readOnly: true })
    const response = await app.inject({
      method: 'POST',
      path,
      headers,
      payload: { ...payload, expectedExecutionEnvironment: 'paper' },
    })
    expect(response.statusCode).toBe(200)
    expect(
      (await app.inject({ method: 'POST', path: '/api/v1/ibkr/orders', headers, payload: place }))
        .statusCode,
    ).toBe(503)
    expect(ibkr.placeOrder).not.toHaveBeenCalled()
  },
)

it('reuses an existing browser session so a second tab leaves the first tab CSRF valid', async () => {
  const { app, headers, bootstrap } = await fixture()
  const second = await app.inject({
    method: 'POST',
    path: '/api/v1/session/bootstrap',
    headers,
    payload: {},
  })
  expect(second.json().csrfToken).toBe(bootstrap.json().csrfToken)
  expect(String(second.headers['set-cookie']).split(';')[0]).toBe(headers.cookie)
  const response = await app.inject({
    method: 'POST',
    path: '/api/v1/ws-tickets',
    headers,
    payload: {},
  })
  expect(response.statusCode).toBe(200)
})
