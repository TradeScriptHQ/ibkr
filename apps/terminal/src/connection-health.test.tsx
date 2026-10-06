import type { HealthResponse, RequirementStatus } from '@ibkr-terminal/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ConnectionRecovery,
  connectionHealthLabel,
  connectionRecoveryDetails,
} from './connection-health.js'

const health: HealthResponse = {
  ok: false,
  mode: 'paper',
  connectionType: 'ib-gateway',
  ibkrHost: '127.0.0.1',
  ibkrPort: 4002,
  backendPort: 3001,
  connectionStatus: 'disconnected',
}
const conflict: RequirementStatus = {
  id: 'tws-session',
  label: 'IB Gateway paper session',
  state: 'disconnected',
  message: 'Client ID already in use.',
  requiredForTrading: true,
  connection: {
    connectionType: 'ib-gateway',
    clientId: 35299,
    issue: 'client-id-in-use',
    retry: {
      attempt: 3,
      maxAttempts: 5,
      exhausted: false,
      nextAttemptAt: '2026-10-04T12:00:04.000Z',
    },
  },
}
const now = Date.parse('2026-10-04T12:00:01.000Z')

describe('broker connection presentation', () => {
  it('shows a client-ID conflict and the backend retry deadline without inventing an internet outage', () => {
    expect(connectionHealthLabel(health, conflict)).toMatchObject({
      tone: 'warning',
      label: 'IB Gateway retrying',
    })
    const html = renderToStaticMarkup(<ConnectionRecovery session={conflict} now={now} />)
    expect(html).toContain('IB Gateway rejected client ID 35299 because it is already in use.')
    expect(html).not.toContain('Open IB Gateway')
    expect(html).toContain('Retrying in 3 seconds (3 of 5)')
    expect(html).not.toMatch(/No Internet|restart|another process/u)
  })

  it('uses the actual deadline for countdowns and reports attempts in progress', () => {
    expect(connectionRecoveryDetails(conflict, now + 2_001)?.retry).toBe(
      'Retrying in 1 second (3 of 5)',
    )
    expect(connectionRecoveryDetails(conflict, now + 3_000)?.retry).toBe(
      'Retrying in 0 seconds (3 of 5)',
    )
    const attempting: RequirementStatus = {
      ...conflict,
      state: 'connecting',
      connection: {
        connectionType: 'ib-gateway',
        clientId: 35299,
        issue: 'client-id-in-use',
        retry: { attempt: 3, maxAttempts: 5, exhausted: false, nextAttemptAt: null },
      },
    }
    expect(connectionRecoveryDetails(attempting, now)?.retry).toBe('Retrying… (3 of 5)')
  })

  it('shows five of five before the final attempt and reports exhaustion without another countdown', () => {
    const finalAttempt: RequirementStatus = {
      ...conflict,
      connection: {
        connectionType: 'ib-gateway',
        clientId: 35299,
        retry: {
          attempt: 5,
          maxAttempts: 5,
          exhausted: false,
          nextAttemptAt: '2026-10-04T12:00:04.000Z',
        },
      },
    }
    expect(connectionRecoveryDetails(finalAttempt, now)?.retry).toBe(
      'Retrying in 3 seconds (5 of 5)',
    )
    const stopped: RequirementStatus = {
      ...finalAttempt,
      state: 'error',
      connection: {
        connectionType: 'ib-gateway',
        clientId: 35299,
        retry: { attempt: 5, maxAttempts: 5, exhausted: true, nextAttemptAt: null },
      },
    }
    expect(connectionRecoveryDetails(stopped, now)?.retry).toBe(
      'Automatic retries stopped (5 of 5)',
    )
    expect(connectionHealthLabel(health, stopped).label).toBe('IB Gateway unavailable')
  })

  it('shows an upstream outage only from the corresponding provider diagnostic', () => {
    const upstream: RequirementStatus = {
      ...conflict,
      state: 'degraded',
      connection: {
        connectionType: 'ib-gateway',
        clientId: 35299,
        issue: 'ibkr-connectivity-lost',
      },
    }
    expect(
      connectionHealthLabel({ ...health, connectionStatus: 'connected' }, upstream),
    ).toMatchObject({
      tone: 'error',
      label: 'IBKR connection lost',
    })
    const html = renderToStaticMarkup(<ConnectionRecovery session={upstream} now={now} />)
    expect(html).toContain('IB Gateway lost its connection to IBKR.')
    expect(html).toContain('Waiting for IB Gateway to restore its IBKR connection.')
    expect(html).not.toContain('client ID')
    expect(html).not.toContain('Automatic retry')
  })

  it('clears recovery details on readiness and keeps market-data disruption distinct', () => {
    const ready: RequirementStatus = {
      ...conflict,
      state: 'ready',
      connection: { connectionType: 'ib-gateway', clientId: 35299 },
    }
    expect(connectionRecoveryDetails(ready, now)).toBeUndefined()
    expect(renderToStaticMarkup(<ConnectionRecovery session={ready} now={now} />)).toBe('')
    expect(
      connectionHealthLabel(
        {
          ...health,
          connectionStatus: 'connected',
          marketDataConnection: {
            status: 'disconnected',
            message: 'Market-data farm disconnected.',
          },
        },
        ready,
      ),
    ).toMatchObject({ label: 'Market data offline', detail: 'Market-data farm disconnected.' })
  })

  it('names a competing live session ahead of market-data farm status', () => {
    const ready: RequirementStatus = {
      ...conflict,
      state: 'ready',
      connection: { connectionType: 'ib-gateway', clientId: 35299 },
    }
    const connected: HealthResponse = {
      ...health,
      connectionStatus: 'connected',
      marketDataConnection: { status: 'connected', message: 'Market data farm connection is OK' },
    }
    expect(
      connectionHealthLabel({ ...connected, competingLiveSession: true }, ready),
    ).toMatchObject({
      tone: 'warning',
      label: 'Market data blocked',
      detail: expect.stringContaining('Restart IB Gateway and log in again'),
    })
    expect(
      connectionHealthLabel({ ...connected, competingLiveSession: false }, ready),
    ).toMatchObject({
      tone: 'connected',
      label: 'IB Gateway connected',
    })
  })

  it('does not turn arbitrary messages or request error codes into a broker diagnosis', () => {
    const unknown: RequirementStatus = {
      ...conflict,
      message: 'No Internet connection. Client ID in use.',
      connection: { connectionType: 'ib-gateway', clientId: 35299 },
    }
    expect(connectionRecoveryDetails(unknown, now)).toBeUndefined()
    expect(connectionHealthLabel(health, unknown).label).toBe('IB Gateway offline')
  })

  it('keeps socket acceptance separate from broker API readiness', () => {
    const socketConnected = { ...health, connectionStatus: 'connected' as const }
    const session: RequirementStatus = {
      ...conflict,
      state: 'connecting',
      message: 'Socket connected; waiting for protocol readiness.',
      connection: { connectionType: 'ib-gateway', clientId: 35299 },
    }
    expect(connectionHealthLabel(socketConnected, session).label).toBe('Connecting…')
    expect(connectionHealthLabel(socketConnected, { ...session, state: 'error' })).toMatchObject({
      tone: 'error',
      label: 'IB Gateway unavailable',
      detail: session.message,
    })
    expect(connectionHealthLabel(socketConnected, { ...session, state: 'reconciling' }).label).toBe(
      'Restoring broker state…',
    )
  })
})
