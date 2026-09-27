import type { ExecutionEnvironment } from '@ibkr-terminal/contracts'
import type {
  AgentConsoleCommands,
  AgentConsoleControllerApi,
  AgentConsoleControllerChangeReason,
  AgentConsoleControllerEvent,
  AgentConsoleGrantRow,
  AgentConsoleSnapshot,
} from '@tradescript/pro/sdk'

export interface McpConsoleState {
  readonly phase: 'connecting' | 'connected' | 'disconnected' | 'error'
  readonly endpoint: string
  readonly sessionId?: string
  readonly surfaces?: readonly { readonly target: unknown; readonly kind: string }[]
  readonly controlCount?: number
  readonly error?: string
}

export interface McpAgentConsoleController extends AgentConsoleControllerApi {
  publishMcp(state: McpConsoleState): void
  destroy(): void
}

function grantRows(state: McpConsoleState): readonly AgentConsoleGrantRow[] {
  return (state.surfaces ?? []).map((surface, index) => ({
    surfaceId: JSON.stringify(surface.target),
    label: surface.kind.length > 0 ? surface.kind : `Surface ${index + 1}`,
    read: true,
    write: true,
  }))
}

function snapshotFor(
  state: McpConsoleState,
  executionEnvironment: ExecutionEnvironment,
  agentTradingEnabled: boolean,
): Omit<AgentConsoleSnapshot, 'revision'> {
  const connected = state.phase === 'connected'
  const connectionStatus =
    state.phase === 'error'
      ? ('error' as const)
      : state.phase === 'connected'
        ? ('connected' as const)
        : state.phase === 'connecting'
          ? ('connecting' as const)
          : ('closed' as const)
  return {
    connection: {
      status: connectionStatus,
      label:
        state.phase === 'connected'
          ? 'Local MCP ready'
          : state.phase === 'connecting'
            ? 'Connecting local MCP…'
            : state.phase === 'error'
              ? 'Local MCP unavailable'
              : 'Local MCP disconnected',
      hops: [
        { id: 'terminal', label: 'TradeScript terminal', status: 'ready' },
        {
          id: 'bridge',
          label: 'Loopback bridge',
          status: state.phase === 'error' ? 'error' : connected ? 'ready' : 'pending',
        },
        {
          id: 'mcp',
          label: 'MCP endpoint',
          status: state.phase === 'error' ? 'error' : connected ? 'ready' : 'pending',
        },
      ],
      ...(state.error === undefined ? {} : { error: state.error }),
    },
    session:
      state.sessionId === undefined
        ? { sessionIdPendingLabel: 'attaching…' }
        : { sessionId: state.sessionId },
    grants: {
      rows: grantRows(state),
      paperTrading: {
        enabled: agentTradingEnabled,
        available: false,
        hint: agentTradingEnabled
          ? `${executionEnvironment} agent trading enabled`
          : 'Agent trading is disabled in Connection settings',
      },
    },
    pairing: {
      mode: 'hosted',
      status: 'ready',
      endpoint: state.endpoint,
      endpointScope: 'loopback',
      credentialStatusLabel: connected ? 'Browser attached' : 'Waiting for browser',
    },
    prompts: connected
      ? [{ id: 'inspect', label: 'Inspect terminal', simulateAvailable: false }]
      : [],
    feed: { entries: [], earlierCount: 0 },
    capabilities:
      state.controlCount === undefined
        ? { status: connected ? 'loading' : 'idle' }
        : {
            status: 'ready',
            summaryLabel: `${state.controlCount} controls · ${state.surfaces?.length ?? 0} surfaces · ${agentTradingEnabled ? `${executionEnvironment} agent trading` : `${executionEnvironment} · agent trading disabled`}`,
          },
    ...(state.phase === 'error'
      ? {
          notice: {
            tone: 'error',
            title: 'MCP bridge error',
            message: state.error ?? 'The local MCP bridge is unavailable.',
          },
        }
      : {}),
  }
}

export function createMcpAgentConsoleController(
  executionEnvironment: ExecutionEnvironment = 'paper',
  agentTradingEnabled = executionEnvironment === 'paper',
): McpAgentConsoleController {
  let state: McpConsoleState = {
    phase: 'connecting',
    endpoint: 'the local MCP endpoint',
  }
  let snapshot: AgentConsoleSnapshot = {
    ...snapshotFor(state, executionEnvironment, agentTradingEnabled),
    revision: 0,
  }
  const listeners = new Set<(event: AgentConsoleControllerEvent) => void>()
  const commands: AgentConsoleCommands = {
    async copyPairingPrompt() {
      const session = state.sessionId === undefined ? '' : `\nSession: ${state.sessionId}`
      await navigator.clipboard.writeText(
        `Connect to the TradeScript MCP endpoint at ${state.endpoint}.${session}\nRead tradescript://sessions and discover exact controls.${agentTradingEnabled ? ` Trading is enabled on the selected ${executionEnvironment} connection.` : ' Agent trading is disabled for this connection.'}`,
      )
    },
    async copyPrompt(promptId) {
      if (promptId !== 'inspect') return
      await navigator.clipboard.writeText(
        `Inspect the attached TradeScript terminal session ${state.sessionId ?? ''}. Read its context and list available controls before making changes.`,
      )
    },
  }

  function publish(reason: AgentConsoleControllerChangeReason): void {
    snapshot = {
      ...snapshotFor(state, executionEnvironment, agentTradingEnabled),
      revision: snapshot.revision + 1,
    }
    const event: AgentConsoleControllerEvent = { reason, revision: snapshot.revision, snapshot }
    listeners.forEach((listener) => {
      listener(event)
    })
  }

  return {
    commands,
    getSnapshot: () => snapshot,
    subscribe(callback, options) {
      listeners.add(callback)
      if (options?.emitCurrent) callback({ reason: 'host', revision: snapshot.revision, snapshot })
      return () => listeners.delete(callback)
    },
    publishMcp(next) {
      state = next
      publish(
        next.phase === 'connected' ? 'connection' : next.phase === 'error' ? 'connection' : 'host',
      )
    },
    destroy() {
      listeners.clear()
    },
  }
}
