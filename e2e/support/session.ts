import type {
  BrokerState,
  ConnectionSnapshot,
  SessionBootstrapResponse,
} from '@ibkr-terminal/contracts'
import { type APIRequestContext, type APIResponse, expect } from '@playwright/test'

import { assertPaperConnection } from './paper-connection.js'

export const TERMINAL_ORIGIN = 'http://localhost:3000'

export const browserHeaders = {
  origin: TERMINAL_ORIGIN,
  'sec-fetch-site': 'same-origin',
  'x-tradescript-client': 'terminal-v1',
}

export interface TerminalSession {
  readonly csrfToken: string
  readonly expiresAt: string
  readonly mutationHeaders: Record<string, string>
}

export async function openTerminalSession(request: APIRequestContext): Promise<TerminalSession> {
  const response = await request.post('/api/v1/session/bootstrap', {
    headers: { ...browserHeaders, 'content-type': 'application/json' },
    data: {},
  })
  expect(
    response.status(),
    `HTTP ${response.status()} from ${new URL(response.url()).pathname}`,
  ).toBe(200)
  const body = (await response.json()) as SessionBootstrapResponse
  expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43,}$/u)
  expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  const connectionResponse = await request.get('/api/v1/connection', { headers: browserHeaders })
  expect(connectionResponse.status()).toBe(200)
  const connection = (await connectionResponse.json()) as ConnectionSnapshot
  const stateResponse = await request.get('/api/v1/ibkr/state', { headers: browserHeaders })
  expect(stateResponse.status()).toBe(200)
  const state = (await stateResponse.json()) as BrokerState
  assertPaperConnection(connection, state)

  return {
    ...body,
    mutationHeaders: {
      ...browserHeaders,
      'content-type': 'application/json',
      'x-tradescript-csrf': body.csrfToken,
      'x-tradescript-connection': connection.generation,
    },
  }
}

export async function expectJsonOk<T = unknown>(response: APIResponse): Promise<T> {
  expect(
    response.status(),
    `HTTP ${response.status()} from ${new URL(response.url()).pathname}`,
  ).toBeGreaterThanOrEqual(200)
  expect(
    response.status(),
    `HTTP ${response.status()} from ${new URL(response.url()).pathname}`,
  ).toBeLessThan(300)
  expect(response.headers()['content-type']).toContain('application/json')
  expect(response.headers()['cache-control']).toBe('no-store')
  return response.json()
}

export async function pollBrokerState<T>(
  request: APIRequestContext,
  predicate: (state: BrokerState) => T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastState: BrokerState | undefined
  while (Date.now() < deadline) {
    const response = await request.get('/api/v1/ibkr/state', { headers: browserHeaders })
    expect(
      response.status(),
      `HTTP ${response.status()} from ${new URL(response.url()).pathname}`,
    ).toBe(200)
    lastState = (await response.json()) as BrokerState
    const value = predicate(lastState)
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`Timed out waiting for broker state: ${JSON.stringify(redactState(lastState))}`)
}

function redactState(state: unknown): unknown {
  if (typeof state !== 'object' || state === null) return state
  const source = state as Record<string, unknown>
  return {
    connectionStatus: source.connectionStatus,
    orderCount: Array.isArray(source.orders) ? source.orders.length : undefined,
    historyCount: Array.isArray(source.ordersHistory) ? source.ordersHistory.length : undefined,
    updatedAt: source.updatedAt,
  }
}

export async function readBrokerState(request: APIRequestContext): Promise<BrokerState> {
  return expectJsonOk<BrokerState>(
    await request.get('/api/v1/ibkr/state', { headers: browserHeaders }),
  )
}
