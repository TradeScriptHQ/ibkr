import { z } from 'zod'

export const ExecutionEnvironmentSchema = z.enum(['paper', 'live'])
export type ExecutionEnvironment = z.infer<typeof ExecutionEnvironmentSchema>

export const ConnectionTypeSchema = z.enum(['tws', 'ib-gateway'])
export type ConnectionType = z.infer<typeof ConnectionTypeSchema>

export function defaultConnectionPort(
  environment: ExecutionEnvironment,
  connectionType: ConnectionType,
): number {
  if (connectionType === 'ib-gateway') return environment === 'live' ? 4001 : 4002
  return environment === 'live' ? 7496 : 7497
}

/** Older connection settings stored only the port. Custom ports keep the TWS default. */
export function inferConnectionType(port: number | undefined): ConnectionType {
  return port === 4001 || port === 4002 ? 'ib-gateway' : 'tws'
}

export function connectionTypeLabel(connectionType: ConnectionType): string {
  return connectionType === 'ib-gateway' ? 'IB Gateway' : 'TWS'
}

export const ComponentStateSchema = z.enum([
  'setup-required',
  'disabled',
  'disconnected',
  'connecting',
  'reconciling',
  'ready',
  'degraded',
  'error',
])
export type ComponentState = z.infer<typeof ComponentStateSchema>

export const BrokerConnectionDiagnosticsSchema = z.object({
  connectionType: ConnectionTypeSchema,
  clientId: z.number().int().nonnegative(),
  issue: z.enum(['client-id-in-use', 'ibkr-connectivity-lost']).optional(),
  retry: z
    .object({
      attempt: z.number().int().nonnegative(),
      maxAttempts: z.number().int().positive(),
      exhausted: z.boolean(),
      nextAttemptAt: z.iso.datetime().nullable(),
    })
    .optional(),
})
export type BrokerConnectionDiagnostics = z.infer<typeof BrokerConnectionDiagnosticsSchema>

export const RequirementStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  state: ComponentStateSchema,
  message: z.string().min(1),
  requiredForTrading: z.boolean(),
  connection: BrokerConnectionDiagnosticsSchema.optional(),
})
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>

export const SystemStatusResponseSchema = z.object({
  service: z.literal('ibkr-trading-gateway'),
  version: z.string().min(1),
  environment: ExecutionEnvironmentSchema,
  ready: z.boolean(),
  tradingEnabled: z.boolean(),
  generatedAt: z.iso.datetime(),
  requirements: z.array(RequirementStatusSchema),
})
export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>

export const ConnectionRetryRequestSchema = z.object({ generation: z.string().min(1) })

export const SessionBootstrapResponseSchema = z.object({
  csrfToken: z.string().min(32),
  expiresAt: z.iso.datetime(),
})
export type SessionBootstrapResponse = z.infer<typeof SessionBootstrapResponseSchema>

export const AgentRiskLimitsSchema = z.object({
  maxOrderQuantity: z.number().positive().nullable(),
  maxOrderNotional: z.number().positive(),
  maxPositionQuantity: z.number().positive().nullable(),
  maxPositionNotional: z.number().positive(),
  maxGrossExposure: z.number().positive().optional(),
  maxDailyLoss: z.number().positive(),
  maxOrdersPerMinute: z.number().int().positive(),
  maxEstimatedSlippageBps: z.number().positive(),
  maxMarketDataAgeMs: z.number().positive(),
  maxLeverage: z.number().positive(),
  maxUnprotectedPositionQuantity: z.number().positive().nullable(),
})
export type AgentRiskLimits = z.infer<typeof AgentRiskLimitsSchema>

export const TradeScriptBootstrapResponseSchema = z.object({
  lease: z.string().min(64),
  leaseType: z.literal('TradeScript-Deployment-Lease'),
  sdkVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  customerBuildFingerprint: z.string().regex(/^tsfp1_[0-9a-f]{32}$/u),
  expiresAt: z.iso.datetime(),
  renewAfter: z.iso.datetime(),
  paperTrading: z.object({
    enabled: z.boolean(),
    autonomyMode: z.literal('paper-auto'),
    allowedAccountIds: z.array(z.string().min(1)),
    limits: AgentRiskLimitsSchema.optional(),
  }),
})
export type TradeScriptBootstrapResponse = z.infer<typeof TradeScriptBootstrapResponseSchema>

export const ApiErrorCodeSchema = z.enum([
  'bad-request',
  'forbidden-origin',
  'invalid-session',
  'invalid-csrf',
  'not-ready',
  'not-found',
  'conflict',
  'rate-limited',
  'outcome-unknown',
  'internal-error',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>

export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
})
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>

export const ConnectionProfileSchema = z.object({
  connectionType: ConnectionTypeSchema.default('tws'),
  limits: TradeScriptBootstrapResponseSchema.shape.paperTrading.shape.limits,
  allowedAccountIds: z.array(z.string().trim().min(1)),
  port: z.number().int().min(1).max(65535),
  clientId: z.number().int().min(0),
  agentTradingEnabled: z.boolean().default(false),
})
function migrateLegacyConnectionProfile(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const profile = value as Record<string, unknown>
  return {
    ...profile,
    ...(profile.connectionType === undefined
      ? {
          connectionType: inferConnectionType(
            typeof profile.port === 'number' ? profile.port : undefined,
          ),
        }
      : {}),
    ...(profile.agentTradingEnabled === undefined
      ? { agentTradingEnabled: profile.permission === 'agent' }
      : {}),
  }
}

export const ConnectionSettingsSchema = z.object({
  active: ExecutionEnvironmentSchema,
  profiles: z.object({
    paper: z.preprocess(migrateLegacyConnectionProfile, ConnectionProfileSchema),
    live: z.preprocess(migrateLegacyConnectionProfile, ConnectionProfileSchema),
  }),
})
export type ConnectionSettings = z.infer<typeof ConnectionSettingsSchema>
export const ConnectionSnapshotSchema = z.object({
  generation: z.string(),
  agentTradingRevision: z.number().int().nonnegative().optional(),
  settings: ConnectionSettingsSchema,
})
export type ConnectionSnapshot = z.infer<typeof ConnectionSnapshotSchema>
