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
const CALL_BUDGET_MS = 29_000
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

export interface TradeScriptMcpBridge {
  /** Adopts the mounted SDK composition while retaining this transport's session identity. */
  replaceAgentic(agentic: AgenticSurfaceAdapterApi): void
  dispose(): void
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
  const code = typeof candidate?.code === 'string' ? candidate.code.trim() : ''
  const message =
    typeof candidate?.message === 'string' ? candidate.message.trim() : String(error).trim()
  return {
    code: (code || 'TRADESCRIPT_CALL_FAILED').slice(0, 160),
    message: (message || 'The TradeScript call failed without an error message').slice(0, 2_000),
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

export function connectTradeScriptMcp({ agentic, onState }: BridgeOptions): TradeScriptMcpBridge {
  let disposed = false
  let socket: WebSocket | undefined
  let reconnectTimer: number | undefined
  let reconnectDelay = 250
  let activeSessionId: string | undefined
  let attached = false
  let authorityRevision = 0
  // The MCP process allocates its port at runtime (the desktop build picks a free one), so the
  // endpoint is only known once a bootstrap response arrives. Never guess it before then.
  let endpoint = 'the local MCP endpoint'
  const subscriptions = new Map<string, SubscriptionState>()

  function publishConnected(): void {
    const surfaces = agentic.listSurfaces()
    const controlIds = new Set<string>()
    for (const surface of surfaces) {
      for (const control of agentic.listEffectiveControls({ target: surface.target })) {
        controlIds.add(control.controlId)
      }
    }
    onState({
      phase: 'connected',
      endpoint,
      ...(activeSessionId === undefined ? {} : { sessionId: activeSessionId }),
      surfaces,
      controlCount: controlIds.size,
    })
  }

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

  async function invokeBeforeDeadline(
    consumerId: string,
    input: CallInput,
    deadlineAt: number,
    isActive: () => boolean,
  ) {
    if (!isActive() || Date.now() >= deadlineAt) {
      throw Object.assign(
        new Error('The MCP execution deadline or session ended before this call started'),
        {
          code: 'BRIDGE_EXECUTION_EXPIRED',
        },
      )
    }
    const operationId = input.requestId ?? crypto.randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    // The race bounds bridge ownership, not the SDK operation. A timed-out operation may still
    // complete, so preserve its identity and require reconciliation instead of claiming failure.
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(
            new Error(
              `Operation ${operationId} exceeded the MCP execution deadline. Its outcome is unknown; reconcile its receipt and actual trading state before retrying.`,
            ),
            { code: 'BRIDGE_OUTCOME_UNKNOWN', operationId },
          ),
        )
      }, deadlineAt - Date.now())
    })
    try {
      return await Promise.race([invoke(consumerId, { ...input, requestId: operationId }), expired])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async function execute(
    method: string,
    paramsValue: unknown,
    isActive: () => boolean,
  ): Promise<unknown> {
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
    const executionBudget = method === 'batch' ? BATCH_BUDGET_MS : CALL_BUDGET_MS
    const deadlineAt =
      typeof params.deadlineAt === 'number' && Number.isFinite(params.deadlineAt)
        ? Math.min(params.deadlineAt, Date.now() + executionBudget)
        : Date.now() + executionBudget
    if (method === 'call') {
      return await invokeBeforeDeadline(
        consumerId,
        params as unknown as CallInput,
        deadlineAt,
        isActive,
      )
    }
    if (method === 'batch') {
      const calls = params.calls as readonly CallInput[]
      const results: unknown[] = []
      // A batch runs sequentially, so without a wall-clock budget a full batch of slow calls could
      // hold this bridge for far longer than any single request timeout. Stop cleanly at the
      // deadline and report exactly where, rather than leaving the caller to guess.
      let budgetExhausted = false
      let sessionEnded = false
      for (let index = 0; index < calls.length; index += 1) {
        if (!isActive()) {
          sessionEnded = true
          break
        }
        if (Date.now() >= deadlineAt) {
          budgetExhausted = true
          break
        }
        const call = calls[index]
        if (call === undefined) continue
        const operationId = call.requestId ?? crypto.randomUUID()
        try {
          results.push({
            index,
            status: 'fulfilled',
            receipt: await invokeBeforeDeadline(
              consumerId,
              { ...call, requestId: operationId },
              deadlineAt,
              isActive,
            ),
          })
        } catch (error) {
          const payload = errorPayload(error)
          if (payload.code === 'BRIDGE_OUTCOME_UNKNOWN') {
            results.push({ index, status: 'outcome-unknown', operationId, error: payload })
            budgetExhausted = true
            break
          }
          results.push({ index, status: 'rejected', error: payload })
          if (params.stopOnError !== false) break
        }
      }
      return {
        sessionId,
        results,
        stoppedEarly: results.length < calls.length,
        ...(sessionEnded ? { sessionEnded: true } : {}),
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
            attached = true
            publishConnected()
            return
          }
          const requestAuthorityRevision = authorityRevision
          const isActive = () =>
            !disposed &&
            socket === websocket &&
            websocket.readyState === WebSocket.OPEN &&
            activeSessionId === bootstrap.sessionId &&
            authorityRevision === requestAuthorityRevision
          try {
            const result = await execute(message.method, message.params, isActive)
            if (!isActive()) return
            websocket.send(
              JSON.stringify({ type: 'response', id: message.id, result: result ?? null }),
            )
          } catch (error) {
            if (!isActive()) return
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
        attached = false
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
  return {
    replaceAgentic(next) {
      if (disposed || next === agentic) return
      closeSubscriptions()
      authorityRevision += 1
      agentic = next
      if (attached) publishConnected()
    },
    dispose() {
      disposed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      closeSubscriptions()
      socket?.close(1000, 'Terminal unmounted')
    },
  }
}
