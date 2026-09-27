import { z } from 'zod'
import { ComponentStateSchema, SystemStatusResponseSchema } from './api.js'

export const GatewayEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connection.status'),
    component: z.enum(['tws', 'tradescript', 'agents']),
    state: ComponentStateSchema,
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal('readiness.changed'),
    status: SystemStatusResponseSchema,
  }),
  z.object({
    type: z.literal('stream.resync-required'),
    reason: z.enum(['cursor-gap', 'buffer-overflow', 'generation-changed']),
  }),
  z.object({
    type: z.literal('heartbeat'),
    serverTime: z.iso.datetime(),
  }),
])
export type GatewayEvent = z.infer<typeof GatewayEventSchema>

export const GatewayEventEnvelopeSchema = z.object({
  sessionGeneration: z.string().min(16),
  cursor: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  event: GatewayEventSchema,
})
export type GatewayEventEnvelope = z.infer<typeof GatewayEventEnvelopeSchema>

export const EventSnapshotResponseSchema = z.object({
  sessionGeneration: z.string().min(16),
  cursor: z.number().int().nonnegative(),
  status: SystemStatusResponseSchema,
})
export type EventSnapshotResponse = z.infer<typeof EventSnapshotResponseSchema>
