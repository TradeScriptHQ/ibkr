import { describe, expect, it } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'

describe('gateway configuration', () => {
  it('boots in safe setup mode without credentials', () => {
    const config = loadGatewayConfig({ NODE_ENV: 'test' })
    expect(config.gateway).toEqual({ host: '127.0.0.1', port: 3001 })
    expect(config.ibkr.port).toBe(7497)
    expect(config.ibkr.bindManualOrders).toBe(false)
    expect(config.agents.enabled).toBe(false)
    expect(config.tradescript.runtimeCredentialsConfigured).toBe(false)
  })

  it('allows configurable ports independently of the mode', () => {
    expect(loadGatewayConfig({ IBKR_PORT: '4012' }).ibkr.port).toBe(4012)
    expect(
      loadGatewayConfig({ IBKR_EXECUTION_ENVIRONMENT: 'live', IBKR_PORT: '4013' }).ibkr,
    ).toMatchObject({ executionEnvironment: 'live', port: 4013 })
  })

  it('rejects public and alias hosts', () => {
    expect(() => loadGatewayConfig({ GATEWAY_HOST: '0.0.0.0' })).toThrow(/literal loopback/u)
    expect(() => loadGatewayConfig({ IBKR_HOST: 'localhost' })).toThrow(/literal loopback/u)
  })

  it('requires exact origin and UI port agreement', () => {
    expect(() =>
      loadGatewayConfig({
        UI_PORT: '3000',
        TRADESCRIPT_REQUESTED_ORIGIN: 'http://localhost:3002',
      }),
    ).toThrow(/must equal UI_PORT/u)
    expect(() =>
      loadGatewayConfig({ TRADESCRIPT_REQUESTED_ORIGIN: 'http://terminal.local:3000' }),
    ).toThrow(/literal loopback/u)
  })

  it('requires client zero for manual TWS binding', () => {
    expect(() =>
      loadGatewayConfig({ IBKR_CLIENT_ID: '7', IBKR_BIND_MANUAL_TWS_ORDERS: 'true' }),
    ).toThrow(/Client ID 0/u)
  })

  it('fails closed when autonomous-agent limits are blank', () => {
    expect(() => loadGatewayConfig({ AGENT_TRADING_ENABLED: 'true' })).toThrow(
      /required limits are missing/u,
    )
  })

  it('accepts finite paper-auto limits and an exact account allowlist', () => {
    const config = loadGatewayConfig({
      AGENT_TRADING_ENABLED: 'true',
      IBKR_ALLOWED_ACCOUNT_IDS: 'DU12345',
      AGENT_MAX_ORDER_QUANTITY: '10',
      AGENT_MAX_ORDER_NOTIONAL: '5000',
      AGENT_MAX_POSITION_QUANTITY: '25',
      AGENT_MAX_POSITION_NOTIONAL: '15000',
      AGENT_MAX_GROSS_EXPOSURE: '25000',
      AGENT_MAX_DAILY_LOSS: '1000',
      AGENT_MAX_ORDERS_PER_MINUTE: '5',
      AGENT_MAX_ESTIMATED_SLIPPAGE_BPS: '50',
      AGENT_MAX_MARKET_DATA_AGE_MS: '5000',
      AGENT_MAX_LEVERAGE: '2',
      AGENT_MAX_UNPROTECTED_POSITION_QUANTITY: '5',
    })
    expect(config.agents.enabled).toBe(true)
    expect(config.agents.riskLimits?.maxOrderNotional).toBe(5000)
  })

  it('rejects partial TradeScript credential sets', () => {
    expect(() => loadGatewayConfig({ TRADESCRIPT_CREDENTIAL_ID: 'credential' })).toThrow(
      /partially configured/u,
    )
  })

  it('accepts a complete HTTPS deployment-lease handoff', () => {
    const config = loadGatewayConfig({
      TRADESCRIPT_CREDENTIAL_ID: 'credential',
      TRADESCRIPT_CREDENTIAL_SECRET: 'one-time-secret',
      TRADESCRIPT_CREDENTIAL_EXCHANGE_URL:
        'https://chart-authorization.tradescript.dev/v1/deployment-leases',
      TRADESCRIPT_SDK_VERSION: '0.1.1',
      TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT: 'tsfp1_0123456789abcdef0123456789abcdef',
    })
    expect(config.tradescript.runtimeCredentialsConfigured).toBe(true)
    expect(config.tradescript.credentialExchangeUrl).toBe(
      'https://chart-authorization.tradescript.dev/v1/deployment-leases',
    )
  })

  it('rejects an insecure deployment-lease exchange URL', () => {
    expect(() =>
      loadGatewayConfig({
        TRADESCRIPT_CREDENTIAL_ID: 'credential',
        TRADESCRIPT_CREDENTIAL_SECRET: 'one-time-secret',
        TRADESCRIPT_CREDENTIAL_EXCHANGE_URL: 'http://localhost/v1/deployment-leases',
        TRADESCRIPT_SDK_VERSION: '0.1.1',
        TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT: 'tsfp1_0123456789abcdef0123456789abcdef',
      }),
    ).toThrow(/HTTPS deployment lease endpoint/u)
  })
})
