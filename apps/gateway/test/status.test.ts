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
  it('enables manual trading only when live orders were explicitly enabled', () => {
    const readOnly = buildSystemStatus(liveConfig(false), readyTws, readyRuntime)
    expect(readOnly).toMatchObject({ environment: 'live', ready: true, tradingEnabled: false })

    const trading = buildSystemStatus(liveConfig(true), readyTws, readyRuntime)
    expect(trading).toMatchObject({ environment: 'live', ready: true, tradingEnabled: true })
    expect(trading.requirements.find(({ id }) => id === 'agent-risk')).toMatchObject({
      state: 'disabled',
    })
  })
})
