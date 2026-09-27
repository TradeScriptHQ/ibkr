import {
  McpBridgeServerMessageSchema,
  McpBrowserSessionResponseSchema,
  type TradeScriptTarget,
} from '@ibkr-terminal/contracts'
import type { AgenticAnyControlDescriptor, AgenticSurfaceAdapterApi } from '@tradescript/pro/sdk'
import type { McpConsoleState } from './agent-console.js'

// A batch runs its calls sequentially, so its worst case is the sum of every call. Cap the whole
// batch instead of letting a 64-call batch occupy the bridge for the sum of 64 request timeouts.
const BATCH_BUDGET_MS = 120_000
// Subscriptions only shrink on an explicit `stop` or a socket close, so bound how many one
// browser session can accumulate. Each one holds live SDK channel work in the terminal.
const MAX_SUBSCRIPTIONS = 32
const MAX_SUBSCRIPTION_CHANNELS = 128
const MAX_EVENTS_PER_SUBSCRIPTION = 512

interface SubscriptionState {
  readonly id: string
  readonly target: TradeScriptTarget
  readonly channels: readonly string[]
  readonly events: Array<{
    readonly sequence: number
    readonly bindingId: string
    readonly channelId: string
    readonly value: unknown
  }>
  readonly unsubscribes: Array<() => void>
  nextSequence: number
}

interface BridgeOptions {
  readonly agentic: AgenticSurfaceAdapterApi
  readonly onState: (state: McpConsoleState) => void
}

interface CallInput {
  readonly target: TradeScriptTarget
  readonly controlId: string
  readonly args?: readonly unknown[]
  readonly expectedRevisions?: Readonly<Record<string, number>>
  readonly requestId?: string
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP bridge params must be an object')
  }
  return value as Record<string, unknown>
}

function errorPayload(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown }
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : 'TRADESCRIPT_CALL_FAILED',
    message: typeof candidate?.message === 'string' ? candidate.message : String(error),
  }
}

function descriptorMatches(
  descriptor: AgenticAnyControlDescriptor,
  input: Record<string, unknown>,
): boolean {
  return (
    (input.controller === undefined || descriptor.controllerId === input.controller) &&
    (input.accessClass === undefined || descriptor.accessClass === input.accessClass) &&
    (input.family === undefined || descriptor.familyId === input.family) &&
    (input.mutation === undefined || descriptor.mutation === input.mutation)
  )
}

export function connectTradeScriptMcp({ agentic, onState }: BridgeOptions): () => void {
  let disposed = false
  let socket: WebSocket | undefined
  let reconnectTimer: number | undefined
  let reconnectDelay = 250
  let activeSessionId: string | undefined
  // The MCP process allocates its port at runtime (the desktop build picks a free one), so the
  // endpoint is only known once a bootstrap response arrives. Never guess it before then.
  let endpoint = 'the local MCP endpoint'
  const subscriptions = new Map<string, SubscriptionState>()

  function closeSubscriptions(): void {
    for (const subscription of subscriptions.values()) {
      subscription.unsubscribes.forEach((unsubscribe) => {
        unsubscribe()
      })
    }
    subscriptions.clear()
  }

  async function invoke(consumerId: string, input: CallInput) {
    return await agentic.invokeAnyGuarded({
      target: input.target,
      controlId: input.controlId,
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(input.expectedRevisions === undefined
        ? {}
        : { expectedRevisions: input.expectedRevisions }),
      operationNamespace: `mcp:${consumerId}`,
      operationId: input.requestId ?? crypto.randomUUID(),
      origin: 'mcp',
    })
  }

  async function execute(method: string, paramsValue: unknown): Promise<unknown> {
    const params = record(paramsValue)
    // Routing check, not an authorization check. It confirms the request names the browser session
    // this page currently holds, so a stale or replayed request cannot be served by a newer
    // attachment. Authority comes from the MCP process (which verifies the session is attached
    // before delegating) and from the SDK policy applied to every invocation below.
    const sessionId = String(params.sessionId ?? activeSessionId ?? '')
    if (sessionId.length === 0 || sessionId !== activeSessionId) {
      throw Object.assign(
        new Error('The MCP request does not match the attached browser session'),
        {
          code: 'SESSION_MISMATCH',
        },
      )
    }
    // The MCP process stamps every delegated request with the identity of the calling MCP client.
    // It attributes receipts to one agent, so a missing value is a bridge defect, not a fallback.
    const consumerId = params.consumerId
    if (typeof consumerId !== 'string' || consumerId.length === 0) {
      throw Object.assign(new Error('The MCP request carries no consumer identity'), {
        code: 'CONSUMER_IDENTITY_MISSING',
      })
    }
    if (method === 'getContext') {
      const context = await agentic.readContext({ target: params.target as TradeScriptTarget })
      return { ...context, sessionId, surfaces: agentic.listSurfaces() }
    }
    if (method === 'listControls') {
      const inspection = agentic.inspectEffectiveCapabilities({
        target: params.target as TradeScriptTarget,
        ...(params.accessClass === undefined
          ? {}
          : { accessClass: params.accessClass as 'read' | 'write' | 'trade' }),
        ...(params.family === undefined ? {} : { familyId: params.family as never }),
        ...(params.unavailableLimit === undefined
          ? {}
          : { unavailableLimit: Number(params.unavailableLimit) }),
      })
      const controls = inspection.effectiveControls.filter((control) =>
        descriptorMatches(control, params),
      )
      const cursor = params.cursor === undefined ? 0 : Number(params.cursor)
      const limit = params.limit === undefined ? 100 : Number(params.limit)
      const page = controls.slice(cursor, cursor + limit)
      return {
        sessionId,
        target: params.target,
        controls: page,
        total: controls.length,
        nextCursor: cursor + page.length < controls.length ? cursor + page.length : null,
        unavailableControls: inspection.unavailableControls,
        unavailableTotal: inspection.unavailableTotal,
        unavailableTruncated: inspection.unavailableTruncated,
        unclassifiedControls: inspection.unclassifiedControls,
        unclassifiedTotal: inspection.unclassifiedTotal,
        unclassifiedTruncated: inspection.unclassifiedTruncated,
      }
    }
    if (method === 'call') return await invoke(consumerId, params as unknown as CallInput)
    if (method === 'batch') {
      const calls = params.calls as readonly CallInput[]
      const results: unknown[] = []
      // A batch runs sequentially, so without a wall-clock budget a full batch of slow calls could
      // hold this bridge for far longer than any single request timeout. Stop cleanly at the
      // deadline and report exactly where, rather than leaving the caller to guess.
      const deadline = Date.now() + BATCH_BUDGET_MS
      let budgetExhausted = false
      for (let index = 0; index < calls.length; index += 1) {
        if (Date.now() >= deadline) {
          budgetExhausted = true
          break
        }
        const call = calls[index]
        if (call === undefined) continue
        try {
          results.push({
            index,
            status: 'fulfilled',
            receipt: await invoke(consumerId, call),
          })
        } catch (error) {
          results.push({ index, status: 'rejected', error: errorPayload(error) })
          if (params.stopOnError !== false) break
        }
      }
      return {
        sessionId,
        results,
        stoppedEarly: results.length < calls.length,
        ...(budgetExhausted
          ? {
              budgetExhausted: true,
              reason: `The batch exceeded its ${BATCH_BUDGET_MS}ms budget`,
            }
          : {}),
      }
    }
    if (method === 'snapshot') {
      return await agentic.snapshot({
        target: params.target as TradeScriptTarget,
        ...(params.options === undefined ? {} : { options: params.options }),
      })
    }
    if (method === 'subscribe') {
      const action = String(params.action)
      if (action === 'start') {
        const target = params.target as TradeScriptTarget
        const bindings = params.bindings as ReadonlyArray<{
          channelId: string
          bindingId?: string
          options?: unknown
        }>
        if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
          throw Object.assign(
            new Error(
              `This session already holds ${MAX_SUBSCRIPTIONS} subscriptions; stop one before starting another`,
            ),
            { code: 'SUBSCRIPTION_LIMIT' },
          )
        }
        const heldChannels = [...subscriptions.values()].reduce(
          (total, subscription) => total + subscription.channels.length,
          0,
        )
        if (heldChannels + bindings.length > MAX_SUBSCRIPTION_CHANNELS) {
          throw Object.assign(
            new Error(
              `This session cannot hold more than ${MAX_SUBSCRIPTION_CHANNELS} channels; ${heldChannels} are already subscribed`,
            ),
            { code: 'SUBSCRIPTION_CHANNEL_LIMIT' },
          )
        }
        const id = crypto.randomUUID()
        const state: SubscriptionState = {
          id,
          target,
          channels: bindings.map(({ channelId }) => channelId),
          events: [],
          unsubscribes: [],
          nextSequence: 1,
        }
        // Reserve the slot before subscribing. Requests are handled concurrently, so checking
        // `subscriptions.size` and inserting afterwards would let simultaneous starts all observe
        // the same pre-insertion size and exceed the cap. If subscribing throws, release it again.
        subscriptions.set(id, state)
        try {
          for (const binding of bindings) {
            const bindingId = binding.bindingId ?? binding.channelId
            state.unsubscribes.push(
              agentic.subscribeAnyChannel(
                {
                  target,
                  channelId: binding.channelId,
                  ...(binding.options === undefined ? {} : { options: binding.options }),
                },
                (value) => {
                  state.events.push({
                    sequence: state.nextSequence,
                    bindingId,
                    channelId: binding.channelId,
                    value,
                  })
                  state.nextSequence += 1
                  if (state.events.length > MAX_EVENTS_PER_SUBSCRIPTION)
                    state.events.splice(0, state.events.length - MAX_EVENTS_PER_SUBSCRIPTION)
                },
              ),
            )
          }
        } catch (error) {
          state.unsubscribes.forEach((unsubscribe) => {
            unsubscribe()
          })
          subscriptions.delete(id)
          throw error
        }
        return { sessionId, subscriptionId: id, target, bindings, nextSequence: state.nextSequence }
      }
      if (action === 'list') {
        return {
          sessionId,
          subscriptions: [...subscriptions.values()].map((state) => ({
            subscriptionId: state.id,
            target: state.target,
            channels: state.channels,
            nextSequence: state.nextSequence,
          })),
        }
      }
      const subscriptionId = String(params.subscriptionId)
      const state = subscriptions.get(subscriptionId)
      if (state === undefined)
        throw Object.assign(new Error('Unknown MCP subscription'), { code: 'UNKNOWN_SUBSCRIPTION' })
      if (action === 'stop') {
        state.unsubscribes.forEach((unsubscribe) => {
          unsubscribe()
        })
        subscriptions.delete(subscriptionId)
        return { sessionId, subscriptionId, stopped: true }
      }
      if (action === 'poll') {
        const after = params.afterSequence === undefined ? 0 : Number(params.afterSequence)
        const limit = params.limit === undefined ? 100 : Number(params.limit)
        const events = state.events.filter(({ sequence }) => sequence > after).slice(0, limit)
        return {
          sessionId,
          subscriptionId,
          events,
          nextSequence: events.at(-1)?.sequence ?? after,
          latestSequence: state.nextSequence - 1,
          truncated: state.events.filter(({ sequence }) => sequence > after).length > events.length,
        }
      }
      throw new Error(`Unsupported subscription action ${action}`)
    }
    throw new Error(`Unsupported MCP bridge method ${method}`)
  }

  async function connect(): Promise<void> {
    if (disposed) return
    onState({ phase: 'connecting', endpoint })
    try {
      await agentic.ready()
      const response = await fetch('/mcp-local/browser-session', { method: 'POST' })
      if (!response.ok) throw new Error(`MCP browser session failed with ${response.status}`)
      const bootstrap = McpBrowserSessionResponseSchema.parse(await response.json())
      if (disposed) return
      endpoint = bootstrap.mcpUrl
      activeSessionId = bootstrap.sessionId
      const websocket = new WebSocket(bootstrap.bridgeUrl)
      socket = websocket
      websocket.addEventListener('open', () => {
        websocket.send(
          JSON.stringify({
            type: 'attach',
            sessionId: bootstrap.sessionId,
            token: bootstrap.bridgeToken,
            title: 'IBKR workstation',
            surfaces: agentic.listSurfaces(),
          }),
        )
      })
      websocket.addEventListener('message', (event) => {
        void (async () => {
          const message = McpBridgeServerMessageSchema.parse(JSON.parse(String(event.data)))
          if (message.type === 'attached') {
            reconnectDelay = 250
            const surfaces = agentic.listSurfaces()
            const controlIds = new Set<string>()
            for (const surface of surfaces) {
              for (const control of agentic.listEffectiveControls({ target: surface.target })) {
                controlIds.add(control.controlId)
              }
            }
            onState({
              phase: 'connected',
              endpoint: bootstrap.mcpUrl,
              sessionId: bootstrap.sessionId,
              surfaces,
              controlCount: controlIds.size,
            })
            return
          }
          try {
            const result = await execute(message.method, message.params)
            websocket.send(
              JSON.stringify({ type: 'response', id: message.id, result: result ?? null }),
            )
          } catch (error) {
            websocket.send(
              JSON.stringify({ type: 'response', id: message.id, error: errorPayload(error) }),
            )
          }
        })().catch((error) => {
          onState({
            phase: 'error',
            endpoint: bootstrap.mcpUrl,
            sessionId: bootstrap.sessionId,
            error: errorPayload(error).message,
          })
        })
      })
      websocket.addEventListener('close', () => {
        if (socket !== websocket || disposed) return
        closeSubscriptions()
        onState({
          phase: 'disconnected',
          endpoint: bootstrap.mcpUrl,
          sessionId: bootstrap.sessionId,
        })
        reconnectTimer = window.setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 4_000)
          void connect()
        }, reconnectDelay)
      })
      websocket.addEventListener('error', () => {
        if (socket === websocket) websocket.close()
      })
    } catch (error) {
      if (disposed) return
      onState({
        phase: 'error',
        endpoint,
        error: errorPayload(error).message,
      })
      reconnectTimer = window.setTimeout(() => void connect(), reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 4_000)
    }
  }

  void connect()
  return () => {
    disposed = true
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
    closeSubscriptions()
    socket?.close(1000, 'Terminal unmounted')
  }
}
