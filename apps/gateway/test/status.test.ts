import { SystemStatusResponseSchema } from '@ibkr-terminal/contracts'
import { describe, expect, it } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { buildSystemStatus } from '../src/status.js'
import type { TwsSessionSnapshot } from '../src/tws/tws-session.js'

const readyTws: TwsSessionSnapshot = {
  generation: 'test-generation',
  state: 'ready',
  message: 'Connected.',
  socketConnected: true,
  nextValidOrderIdReady: true,
  reconciliationComplete: true,
  managedAccountIds: ['U123'],
  allowedAccountIds: ['U123'],
  matchedAccountIds: ['U123'],
  openOrderCount: 0,
  completedOrderCount: 0,
  positionCount: 0,
  executionCount: 0,
  connection: { connectionType: 'tws', clientId: 0 },
}

const readyRuntime = {
  auditDatabaseReady: true,
  sdkInstalled: true,
  leaseReady: true,
}

function liveConfig(liveOrdersEnabled: boolean) {
  return loadGatewayConfig({
    NODE_ENV: 'test',
    IBKR_EXECUTION_ENVIRONMENT: 'live',
    IBKR_PORT: '7496',
    IBKR_ALLOWED_ACCOUNT_IDS: 'U123',
    ...(liveOrdersEnabled ? { WIDGET_IBKR_ENABLE_LIVE_ORDERS: 'I_UNDERSTAND' } : {}),
    TRADESCRIPT_CREDENTIAL_ID: 'credential',
    TRADESCRIPT_CREDENTIAL_SECRET: 'secret',
    TRADESCRIPT_CREDENTIAL_EXCHANGE_URL:
      'https://chart-authorization.tradescript.dev/v1/deployment-leases',
    TRADESCRIPT_SDK_VERSION: '0.1.31',
    TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT: 'tsfp1_test',
  })
}

describe('gateway system status', () => {
  it('transports broker diagnostics and retry timing through the public status schema', () => {
    const connection = {
      connectionType: 'ib-gateway' as const,
      clientId: 35299,
      issue: 'client-id-in-use' as const,
      retry: {
        attempt: 3,
        maxAttempts: 5,
        exhausted: false,
        nextAttemptAt: '2026-10-04T12:00:04.000Z',
      },
    }
    const status = SystemStatusResponseSchema.parse(
      buildSystemStatus(
        liveConfig(false),
        { ...readyTws, state: 'disconnected', reconciliationComplete: false, connection },
        readyRuntime,
      ),
    )
    expect(status.requirements.find(({ id }) => id === 'tws-session')?.connection).toEqual(
      connection,
    )
    expect(status.ready).toBe(false)
    expect(status.tradingEnabled).toBe(false)
  })
  it('enables manual trading on ready connections independently of legacy trading flags', () => {
    const config = liveConfig(false)
    const formerlyReadOnly = buildSystemStatus(
      { ...config, ibkr: { ...config.ibkr, tradingEnabled: false } },
      readyTws,
      readyRuntime,
    )
    expect(formerlyReadOnly).toMatchObject({
      environment: 'live',
      ready: true,
      tradingEnabled: true,
    })

    const trading = buildSystemStatus(liveConfig(true), readyTws, readyRuntime)
    expect(trading).toMatchObject({ environment: 'live', ready: true, tradingEnabled: true })
    expect(trading.requirements.find(({ id }) => id === 'agent-risk')).toMatchObject({
      state: 'disabled',
    })
    expect(trading.requirements.find(({ id }) => id === 'tws-session')?.label).toBe(
      'TWS live session',
    )
  })

  it.each(['auditDatabaseReady', 'sdkInstalled', 'leaseReady'] as const)(
    'blocks manual trading when %s is unavailable',
    (requirement) => {
      expect(
        buildSystemStatus(liveConfig(false), readyTws, {
          ...readyRuntime,
          [requirement]: false,
        }),
      ).toMatchObject({ ready: false, tradingEnabled: false })
    },
  )

  it('blocks manual trading until account reconciliation is complete', () => {
    expect(
      buildSystemStatus(
        liveConfig(false),
        { ...readyTws, reconciliationComplete: false },
        readyRuntime,
      ),
    ).toMatchObject({ ready: false, tradingEnabled: false })
    expect(
      buildSystemStatus(liveConfig(false), { ...readyTws, matchedAccountIds: [] }, readyRuntime),
    ).toMatchObject({ ready: false, tradingEnabled: false })
  })

  it('names IB Gateway in readiness and account details, including legacy port-only configuration', () => {
    const config = loadGatewayConfig({ IBKR_CONNECTION_TYPE: 'ib-gateway' })
    const gateway = buildSystemStatus(config, readyTws, readyRuntime)
    expect(gateway.requirements.find(({ id }) => id === 'tws-session')?.label).toBe(
      'IB Gateway paper session',
    )
    expect(gateway.requirements.find(({ id }) => id === 'paper-account')?.message).toBe(
      'The connected IB Gateway session contains an allowlisted account.',
    )
    const legacyIbkr = { ...config.ibkr }
    delete legacyIbkr.connectionType
    const legacy = buildSystemStatus({ ...config, ibkr: legacyIbkr }, readyTws, readyRuntime)
    expect(legacy.requirements.find(({ id }) => id === 'tws-session')?.label).toBe(
      'IB Gateway paper session',
    )
  })
})
