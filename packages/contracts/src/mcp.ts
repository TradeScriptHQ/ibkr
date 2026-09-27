import { z } from 'zod'

export const TradeScriptTargetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('session') }).strict(),
  z.object({ scope: z.literal('chart'), chartId: z.string().min(1).max(128) }).strict(),
  z.object({ scope: z.literal('widget'), widgetId: z.string().min(1).max(128) }).strict(),
])
export type TradeScriptTarget = z.infer<typeof TradeScriptTargetSchema>

export const McpBrowserSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  mcpUrl: z.url(),
  bridgeUrl: z.url(),
  bridgeToken: z.string().min(32),
  expiresAt: z.iso.datetime(),
})
export type McpBrowserSessionResponse = z.infer<typeof McpBrowserSessionResponseSchema>

export const McpBridgeAttachMessageSchema = z
  .object({
    type: z.literal('attach'),
    sessionId: z.string().uuid(),
    token: z.string().min(32),
    title: z.string().min(1).max(160),
    surfaces: z.array(z.unknown()).max(256),
  })
  .strict()

export const McpBridgeResponseMessageSchema = z
  .object({
    type: z.literal('response'),
    id: z.string().uuid(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1).max(160),
        message: z.string().min(1).max(2_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((message) => (message.error === undefined) !== (message.result === undefined), {
    message: 'A bridge response must contain exactly one of result or error',
  })

export const McpBridgeClientMessageSchema = z.discriminatedUnion('type', [
  McpBridgeAttachMessageSchema,
  McpBridgeResponseMessageSchema,
])
export type McpBridgeClientMessage = z.infer<typeof McpBridgeClientMessageSchema>

export const McpBridgeAttachedMessageSchema = z
  .object({
    type: z.literal('attached'),
    sessionId: z.string().uuid(),
  })
  .strict()

export const McpBridgeRequestMessageSchema = z
  .object({
    type: z.literal('request'),
    id: z.string().uuid(),
    method: z.enum(['getContext', 'listControls', 'call', 'batch', 'subscribe', 'snapshot']),
    params: z.unknown(),
  })
  .strict()

export const McpBridgeServerMessageSchema = z.discriminatedUnion('type', [
  McpBridgeAttachedMessageSchema,
  McpBridgeRequestMessageSchema,
])
export type McpBridgeServerMessage = z.infer<typeof McpBridgeServerMessageSchema>
