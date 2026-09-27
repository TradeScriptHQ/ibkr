import { z } from 'zod'

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const BooleanStringSchema = z.preprocess(
  emptyToUndefined,
  z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
)

const IntegerStringSchema = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().nonnegative().optional(),
)

const PositiveNumberStringSchema = z.preprocess(
  emptyToUndefined,
  z.coerce.number().finite().positive().optional(),
)

const OptionalStringSchema = z.preprocess(emptyToUndefined, z.string().min(1).optional())

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  UI_HOST: OptionalStringSchema,
  UI_PORT: IntegerStringSchema,
  GATEWAY_HOST: OptionalStringSchema,
  GATEWAY_PORT: IntegerStringSchema,
  TRADESCRIPT_PACKAGE_NAME: OptionalStringSchema,
  TRADESCRIPT_CREDENTIAL_ID: OptionalStringSchema,
  TRADESCRIPT_CREDENTIAL_SECRET: OptionalStringSchema,
  TRADESCRIPT_CREDENTIAL_EXCHANGE_URL: OptionalStringSchema,
  TRADESCRIPT_SDK_VERSION: OptionalStringSchema,
  TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT: OptionalStringSchema,
  TRADESCRIPT_REQUESTED_ORIGIN: OptionalStringSchema,
  IBKR_HOST: OptionalStringSchema,
  IBKR_PORT: IntegerStringSchema,
  IBKR_CLIENT_ID: IntegerStringSchema,
  IBKR_MASTER_CLIENT_ID: IntegerStringSchema,
  IBKR_BIND_MANUAL_TWS_ORDERS: BooleanStringSchema,
  IBKR_EXECUTION_ENVIRONMENT: z.preprocess(emptyToUndefined, z.enum(['paper', 'live']).optional()),
  WIDGET_IBKR_ENABLE_LIVE_ORDERS: z.preprocess(
    emptyToUndefined,
    z.literal('I_UNDERSTAND').optional(),
  ),
  IBKR_ALLOWED_ACCOUNT_IDS: OptionalStringSchema,
  AGENT_TRADING_ENABLED: BooleanStringSchema,
  AGENT_AUTONOMY_MODE: z.preprocess(emptyToUndefined, z.literal('paper-auto').optional()),
  AGENT_MAX_ORDER_QUANTITY: PositiveNumberStringSchema,
  AGENT_MAX_ORDER_NOTIONAL: PositiveNumberStringSchema,
  AGENT_MAX_POSITION_QUANTITY: PositiveNumberStringSchema,
  AGENT_MAX_POSITION_NOTIONAL: PositiveNumberStringSchema,
  AGENT_MAX_GROSS_EXPOSURE: PositiveNumberStringSchema,
  AGENT_MAX_DAILY_LOSS: PositiveNumberStringSchema,
  AGENT_MAX_ORDERS_PER_MINUTE: PositiveNumberStringSchema,
  AGENT_MAX_ESTIMATED_SLIPPAGE_BPS: PositiveNumberStringSchema,
  AGENT_MAX_MARKET_DATA_AGE_MS: PositiveNumberStringSchema,
  AGENT_MAX_LEVERAGE: PositiveNumberStringSchema,
  AGENT_MAX_UNPROTECTED_POSITION_QUANTITY: PositiveNumberStringSchema,
})

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parseExactLoopbackOrigin(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('TRADESCRIPT_REQUESTED_ORIGIN must be a valid absolute URL')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('TRADESCRIPT_REQUESTED_ORIGIN must use http or https')
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('TRADESCRIPT_REQUESTED_ORIGIN must use a literal loopback host')
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('TRADESCRIPT_REQUESTED_ORIGIN must contain only scheme, host, and port')
  }
  return url
}

function parseCredentialExchangeUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('TRADESCRIPT_CREDENTIAL_EXCHANGE_URL must be a valid absolute URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.endsWith('/v1/deployment-leases')
  ) {
    throw new Error(
      'TRADESCRIPT_CREDENTIAL_EXCHANGE_URL must be an HTTPS deployment lease endpoint',
    )
  }
  return url
}

function parseAccountIds(value: string | undefined): readonly string[] {
  if (value === undefined) return []
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return [...new Set(ids)]
}

function allOrNone(label: string, values: Readonly<Record<string, string | undefined>>): boolean {
  const configured = Object.values(values).filter((value) => value !== undefined).length
  if (configured !== 0 && configured !== Object.keys(values).length) {
    const missing = Object.entries(values)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key)
      .join(', ')
    throw new Error(`${label} is partially configured; missing ${missing}`)
  }
  return configured > 0
}

export interface AgentRiskLimits {
  readonly maxOrderQuantity: number
  readonly maxOrderNotional: number
  readonly maxPositionQuantity: number
  readonly maxPositionNotional: number
  readonly maxGrossExposure?: number | undefined
  readonly maxDailyLoss: number
  readonly maxOrdersPerMinute: number
  readonly maxEstimatedSlippageBps: number
  readonly maxMarketDataAgeMs: number
  readonly maxLeverage: number
  readonly maxUnprotectedPositionQuantity: number
}

export interface GatewayConfig {
  readonly nodeEnvironment: 'development' | 'test' | 'production'
  readonly ui: {
    readonly host: '127.0.0.1'
    readonly port: number
    readonly origin: string
  }
  readonly gateway: {
    readonly host: '127.0.0.1'
    readonly port: number
  }
  readonly tradescript: {
    readonly packageName: string
    readonly runtimeCredentialsConfigured: boolean
    readonly sdkVersion?: string
    readonly customerBuildFingerprint?: string
    readonly credentialId?: string
    readonly credentialSecret?: string
    readonly credentialExchangeUrl?: string
    readonly requestedOrigin: string
  }
  readonly ibkr: {
    readonly host: '127.0.0.1'
    readonly port: number
    readonly clientId: number
    readonly masterClientId: number
    readonly bindManualOrders: boolean
    readonly executionEnvironment: 'paper' | 'live'
    readonly liveOrdersEnabled: boolean
    readonly tradingEnabled?: boolean
    readonly allowedAccountIds: readonly string[]
  }
  readonly agents: {
    readonly enabled: boolean
    readonly autonomyMode: 'paper-auto'
    readonly riskLimits?: AgentRiskLimits
  }
}

export function loadGatewayConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = EnvironmentSchema.parse(environment)
  const requestedOrigin = parseExactLoopbackOrigin(
    parsed.TRADESCRIPT_REQUESTED_ORIGIN ?? 'http://localhost:3000',
  )
  const uiPort = parsed.UI_PORT ?? 3000
  const gatewayPort = parsed.GATEWAY_PORT ?? 3001
  const executionEnvironment = parsed.IBKR_EXECUTION_ENVIRONMENT ?? 'paper'
  const ibkrPort = parsed.IBKR_PORT ?? (executionEnvironment === 'live' ? 7496 : 7497)
  const clientId = parsed.IBKR_CLIENT_ID ?? 0
  const masterClientId = parsed.IBKR_MASTER_CLIENT_ID ?? 0
  const bindManualOrders = parsed.IBKR_BIND_MANUAL_TWS_ORDERS ?? false
  const liveOrdersEnabled = parsed.WIDGET_IBKR_ENABLE_LIVE_ORDERS === 'I_UNDERSTAND'
  const allowedAccountIds = parseAccountIds(parsed.IBKR_ALLOWED_ACCOUNT_IDS)
  const agentsEnabled = parsed.AGENT_TRADING_ENABLED ?? false

  if ((parsed.UI_HOST ?? '127.0.0.1') !== '127.0.0.1') {
    throw new Error('UI_HOST must be the literal loopback address 127.0.0.1')
  }
  if ((parsed.GATEWAY_HOST ?? '127.0.0.1') !== '127.0.0.1') {
    throw new Error('GATEWAY_HOST must be the literal loopback address 127.0.0.1')
  }
  if ((parsed.IBKR_HOST ?? '127.0.0.1') !== '127.0.0.1') {
    throw new Error('IBKR_HOST must be the literal loopback address 127.0.0.1')
  }
  if (liveOrdersEnabled && executionEnvironment !== 'live') {
    throw new Error('WIDGET_IBKR_ENABLE_LIVE_ORDERS requires IBKR_EXECUTION_ENVIRONMENT=live')
  }
  if (bindManualOrders && (clientId !== 0 || masterClientId !== 0)) {
    throw new Error('Manual TWS order binding requires API and Master Client ID 0')
  }
  if (requestedOrigin.port !== String(uiPort)) {
    throw new Error('TRADESCRIPT_REQUESTED_ORIGIN port must equal UI_PORT')
  }

  const runtimeCredentialsConfigured = allOrNone('TradeScript runtime authorization', {
    TRADESCRIPT_CREDENTIAL_ID: parsed.TRADESCRIPT_CREDENTIAL_ID,
    TRADESCRIPT_CREDENTIAL_SECRET: parsed.TRADESCRIPT_CREDENTIAL_SECRET,
  })
  const credentialExchangeUrl = parseCredentialExchangeUrl(
    parsed.TRADESCRIPT_CREDENTIAL_EXCHANGE_URL ??
      'https://chart-authorization.tradescript.dev/api/chart-authorization/v1/deployment-leases',
  ).toString()

  if (
    runtimeCredentialsConfigured &&
    (!parsed.TRADESCRIPT_SDK_VERSION || !parsed.TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT)
  )
    throw new Error('TradeScript runtime authorization requires SDK version and build fingerprint')

  let riskLimits: AgentRiskLimits | undefined
  if (agentsEnabled) {
    const missing: string[] = []
    if (allowedAccountIds.length === 0) missing.push('IBKR_ALLOWED_ACCOUNT_IDS')
    if (parsed.AGENT_MAX_ORDER_QUANTITY === undefined) missing.push('AGENT_MAX_ORDER_QUANTITY')
    if (parsed.AGENT_MAX_ORDER_NOTIONAL === undefined) missing.push('AGENT_MAX_ORDER_NOTIONAL')
    if (parsed.AGENT_MAX_POSITION_QUANTITY === undefined) {
      missing.push('AGENT_MAX_POSITION_QUANTITY')
    }
    if (parsed.AGENT_MAX_POSITION_NOTIONAL === undefined) {
      missing.push('AGENT_MAX_POSITION_NOTIONAL')
    }
    if (parsed.AGENT_MAX_GROSS_EXPOSURE === undefined) missing.push('AGENT_MAX_GROSS_EXPOSURE')
    if (parsed.AGENT_MAX_DAILY_LOSS === undefined) missing.push('AGENT_MAX_DAILY_LOSS')
    if (parsed.AGENT_MAX_ORDERS_PER_MINUTE === undefined) {
      missing.push('AGENT_MAX_ORDERS_PER_MINUTE')
    }
    if (parsed.AGENT_MAX_ESTIMATED_SLIPPAGE_BPS === undefined) {
      missing.push('AGENT_MAX_ESTIMATED_SLIPPAGE_BPS')
    }
    if (parsed.AGENT_MAX_MARKET_DATA_AGE_MS === undefined) {
      missing.push('AGENT_MAX_MARKET_DATA_AGE_MS')
    }
    if (parsed.AGENT_MAX_LEVERAGE === undefined) missing.push('AGENT_MAX_LEVERAGE')
    if (parsed.AGENT_MAX_UNPROTECTED_POSITION_QUANTITY === undefined) {
      missing.push('AGENT_MAX_UNPROTECTED_POSITION_QUANTITY')
    }
    if (missing.length > 0) {
      throw new Error(
        `Agent paper trading is enabled but required limits are missing: ${missing.join(', ')}`,
      )
    }
    riskLimits = {
      maxOrderQuantity: parsed.AGENT_MAX_ORDER_QUANTITY as number,
      maxOrderNotional: parsed.AGENT_MAX_ORDER_NOTIONAL as number,
      maxPositionQuantity: parsed.AGENT_MAX_POSITION_QUANTITY as number,
      maxPositionNotional: parsed.AGENT_MAX_POSITION_NOTIONAL as number,
      maxGrossExposure: parsed.AGENT_MAX_GROSS_EXPOSURE as number,
      maxDailyLoss: parsed.AGENT_MAX_DAILY_LOSS as number,
      maxOrdersPerMinute: parsed.AGENT_MAX_ORDERS_PER_MINUTE as number,
      maxEstimatedSlippageBps: parsed.AGENT_MAX_ESTIMATED_SLIPPAGE_BPS as number,
      maxMarketDataAgeMs: parsed.AGENT_MAX_MARKET_DATA_AGE_MS as number,
      maxLeverage: parsed.AGENT_MAX_LEVERAGE as number,
      maxUnprotectedPositionQuantity: parsed.AGENT_MAX_UNPROTECTED_POSITION_QUANTITY as number,
    }
  }

  return {
    nodeEnvironment: parsed.NODE_ENV ?? 'development',
    ui: { host: '127.0.0.1', port: uiPort, origin: requestedOrigin.origin },
    gateway: { host: '127.0.0.1', port: gatewayPort },
    tradescript: {
      packageName: parsed.TRADESCRIPT_PACKAGE_NAME ?? '@tradescript/pro-localhost',
      runtimeCredentialsConfigured,
      ...(parsed.TRADESCRIPT_SDK_VERSION === undefined
        ? {}
        : { sdkVersion: parsed.TRADESCRIPT_SDK_VERSION }),
      ...(parsed.TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT === undefined
        ? {}
        : { customerBuildFingerprint: parsed.TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT }),
      ...(parsed.TRADESCRIPT_CREDENTIAL_ID === undefined
        ? {}
        : { credentialId: parsed.TRADESCRIPT_CREDENTIAL_ID }),
      ...(parsed.TRADESCRIPT_CREDENTIAL_SECRET === undefined
        ? {}
        : { credentialSecret: parsed.TRADESCRIPT_CREDENTIAL_SECRET }),
      ...(credentialExchangeUrl === undefined ? {} : { credentialExchangeUrl }),
      requestedOrigin: requestedOrigin.origin,
    },
    ibkr: {
      host: '127.0.0.1',
      port: ibkrPort,
      clientId,
      masterClientId,
      bindManualOrders,
      executionEnvironment,
      liveOrdersEnabled,
      allowedAccountIds,
    },
    agents: {
      enabled: agentsEnabled,
      autonomyMode: parsed.AGENT_AUTONOMY_MODE ?? 'paper-auto',
      ...(riskLimits === undefined ? {} : { riskLimits }),
    },
  }
}
