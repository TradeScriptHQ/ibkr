import { z } from 'zod'

export const ExecutionEnvironmentSchema = z.enum(['paper', 'live'])
export type ExecutionEnvironment = z.infer<typeof ExecutionEnvironmentSchema>

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

export const RequirementStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  state: ComponentStateSchema,
  message: z.string().min(1),
  requiredForTrading: z.boolean(),
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

export const SessionBootstrapResponseSchema = z.object({
  csrfToken: z.string().min(32),
  expiresAt: z.iso.datetime(),
})
export type SessionBootstrapResponse = z.infer<typeof SessionBootstrapResponseSchema>

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
    limits: z
      .object({
        maxOrderQuantity: z.number().positive(),
        maxOrderNotional: z.number().positive(),
        maxPositionQuantity: z.number().positive(),
        maxPositionNotional: z.number().positive(),
        maxGrossExposure: z.number().positive().optional(),
        maxDailyLoss: z.number().positive(),
        maxOrdersPerMinute: z.number().positive(),
        maxEstimatedSlippageBps: z.number().positive(),
        maxMarketDataAgeMs: z.number().positive(),
        maxLeverage: z.number().positive(),
        maxUnprotectedPositionQuantity: z.number().positive(),
      })
      .optional(),
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
  limits: TradeScriptBootstrapResponseSchema.shape.paperTrading.shape.limits,
  allowedAccountIds: z.array(z.string().trim().min(1)),
  port: z.number().int().min(1).max(65535),
  clientId: z.number().int().min(0),
  permission: z.enum(['read-only', 'manual', 'agent']),
})
export const ConnectionSettingsSchema = z.object({
  active: ExecutionEnvironmentSchema,
  profiles: z.object({ paper: ConnectionProfileSchema, live: ConnectionProfileSchema }),
})
export type ConnectionSettings = z.infer<typeof ConnectionSettingsSchema>
export const ConnectionSnapshotSchema = z.object({
  generation: z.string(),
  settings: ConnectionSettingsSchema,
})
export type ConnectionSnapshot = z.infer<typeof ConnectionSnapshotSchema>
