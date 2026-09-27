import { TradeScriptTargetSchema } from '@ibkr-terminal/contracts'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BrowserBridge } from './browser-bridge.js'
import { bridgeError } from './http.js'

function stripConsumerId(call: Record<string, unknown>): Record<string, unknown> {
  const { consumerId: _consumerId, ...rest } = call
  return rest
}

// `batch` is the one method whose input nests further call shapes. Narrow it once here so the
// delegation path stays typed rather than casting at the call site.
function batchCalls(input: object): readonly Record<string, unknown>[] {
  const calls = (input as { calls?: unknown }).calls
  return Array.isArray(calls) ? (calls as readonly Record<string, unknown>[]) : []
}

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    // `structuredContent` is declared as an object in the MCP result contract, so a scalar or
    // array result must not be cast into it. Omit the field rather than send a shape the client
    // cannot rely on.
    ...(typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  }
}

function errorResult(error: unknown) {
  const payload = { error: bridgeError(error) }
  return {
    ...textResult(payload),
    isError: true,
  }
}

// The SDK derives each tool's input type from its zod shape. This wrapper preserves that type
// instead of widening it to a bare record, so handlers read their own validated fields without
// casting away the schema's guarantees.
function guarded<TInput>(
  handler: (input: TInput) => Promise<unknown>,
): (input: TInput) => Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  return async (input) => {
    try {
      return textResult(await handler(input))
    } catch (error) {
      return errorResult(error)
    }
  }
}

const sessionId = z.string().uuid()
const target = TradeScriptTargetSchema
const jsonValue = z.json()
const revisions = z.record(z.string(), z.number().int().nonnegative())
const callShape = {
  target,
  controlId: z.string().min(1).max(160),
  args: z.array(jsonValue).max(64).optional(),
  expectedRevisions: revisions.optional(),
  requestId: z.string().min(1).max(128).optional(),
} as const

export function createTradeScriptMcpServer(consumerId: string, bridge: BrowserBridge): McpServer {
  const server = new McpServer(
    { name: 'ibkr-tradescript-terminal', version: '0.1.0' },
    {
      capabilities: { resources: { listChanged: true } },
      instructions:
        'Read tradescript://sessions, choose an attached session and explicit target, then discover exact controls before calling them. Carry current expectedRevisions for mutations. Trading is constrained to the terminal paper account and host risk policy.',
    },
  )

  // The browser attributes every receipt to this identity, so it must travel with each delegated
  // request. `batch` carries it once for the whole batch: the individual calls are control
  // arguments, not identity, and a per-call value could only ever disagree with the caller.
  const delegate = <TInput extends { sessionId: string }>(
    method: string,
    input: TInput,
  ): Promise<unknown> =>
    bridge.request(input.sessionId, method, {
      ...input,
      consumerId,
      ...(method === 'batch' ? { calls: batchCalls(input).map(stripConsumerId) } : {}),
    })

  server.registerTool(
    'tradescript_get_context',
    {
      title: 'Get TradeScript context',
      description:
        'Read mounted surfaces, projected state, revisions, and subscriptions for one explicit TradeScript target.',
      inputSchema: { sessionId, target },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (input) => delegate('getContext', input)),
  )

  server.registerTool(
    'tradescript_list_controls',
    {
      title: 'List TradeScript controls',
      description:
        'Discover the exact SDK controls currently available on an attached target, including canonical unavailable reasons.',
      inputSchema: {
        sessionId,
        target,
        controller: z.string().min(1).max(160).optional(),
        accessClass: z.enum(['read', 'write', 'trade']).optional(),
        family: z.string().min(1).max(160).optional(),
        mutation: z.boolean().optional(),
        cursor: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        unavailableLimit: z.number().int().min(1).max(1_000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async (input) => delegate('listControls', input)),
  )

  server.registerTool(
    'tradescript_call',
    {
      title: 'Call TradeScript control',
      description:
        'Invoke one discovered SDK control against an explicit target with guarded revisions and a correlated receipt.',
      inputSchema: { sessionId, ...callShape },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(async (input) => delegate('call', input)),
  )

  server.registerTool(
    'tradescript_batch',
    {
      title: 'Batch TradeScript controls',
      description:
        'Run up to 64 ordered SDK controls. The batch is non-atomic and can stop on the first rejected call.',
      inputSchema: {
        sessionId,
        calls: z.array(z.object(callShape).strict()).min(1).max(64),
        stopOnError: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(async (input) => delegate('batch', input)),
  )

  const binding = z
    .object({
      channelId: z.string().min(1).max(160),
      bindingId: z.string().min(1).max(128).optional(),
      options: jsonValue.optional(),
    })
    .strict()
  server.registerTool(
    'tradescript_subscribe',
    {
      title: 'Subscribe to TradeScript events',
      description:
        'Start, poll, list, or stop a bounded SDK event subscription without serializing callbacks across MCP.',
      inputSchema: {
        sessionId,
        action: z.enum(['start', 'poll', 'list', 'stop']),
        target: target.optional(),
        bindings: z.array(binding).min(1).max(32).optional(),
        subscriptionId: z.string().uuid().optional(),
        afterSequence: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(256).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(async (input) => delegate('subscribe', input)),
  )

  server.registerTool(
    'tradescript_snapshot',
    {
      title: 'Capture TradeScript snapshot',
      description: 'Capture an authorized chart or widget target as a bounded image result.',
      inputSchema: { sessionId, target, options: z.record(z.string(), jsonValue).optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = (await delegate('snapshot', input)) as {
          dataUrl: string
          mimeType: string
          byteLength: number
        }
        const comma = result.dataUrl.indexOf(',')
        if (comma < 0) throw new Error('TradeScript returned an invalid snapshot data URL')
        return {
          content: [
            {
              type: 'image' as const,
              data: result.dataUrl.slice(comma + 1),
              mimeType: result.mimeType,
            },
            {
              type: 'text' as const,
              text: JSON.stringify({ mimeType: result.mimeType, byteLength: result.byteLength }),
            },
          ],
          structuredContent: {
            sessionId: input.sessionId,
            target: input.target,
            mimeType: result.mimeType,
            byteLength: result.byteLength,
          },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerResource(
    'tradescript-sessions',
    'tradescript://sessions',
    {
      title: 'Attached TradeScript sessions',
      description: 'Browser sessions currently attached to this local MCP bridge.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(bridge.sessions(), null, 2),
        },
      ],
    }),
  )

  return server
}
