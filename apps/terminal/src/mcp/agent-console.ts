import type { ExecutionEnvironment } from '@ibkr-terminal/contracts'
import type {
  AgentConsoleCommands,
  AgentConsoleControllerApi,
  AgentConsoleControllerChangeReason,
  AgentConsoleControllerEvent,
  AgentConsoleGrantRow,
  AgentConsoleSnapshot,
} from '@tradescript/pro/sdk'
import { APP_NAME } from '../branding.js'
import type { AgentRiskAvailability } from '../workstation-agent-risk.js'

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
  publishAgentRisk(state: AgentRiskAvailability): void
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
  agentRisk: AgentRiskAvailability,
): Omit<AgentConsoleSnapshot, 'revision'> {
  const agentTradingEnabled = agentRisk.state === 'ready'
  const agentTradingHint = agentTradingEnabled
    ? `${executionEnvironment} agent trading enabled`
    : agentRisk.state === 'unavailable'
      ? `Agent trading paused: ${agentRisk.message}`
      : agentRisk.state === 'checking'
        ? 'Checking agent trading safety. Agent orders are blocked.'
        : 'Agent trading is turned off.'
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
        { id: 'terminal', label: APP_NAME, status: 'ready' },
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
        hint: agentTradingHint,
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
            summaryLabel: `${state.controlCount} controls · ${state.surfaces?.length ?? 0} surfaces · ${agentTradingEnabled ? `${executionEnvironment} agent trading` : `${executionEnvironment} · agent trading ${agentRisk.state === 'unavailable' ? 'paused' : agentRisk.state === 'checking' ? 'checking' : 'disabled'}`}`,
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
  executionEnvironment: ExecutionEnvironment,
  agentRisk: AgentRiskAvailability,
): McpAgentConsoleController {
  let state: McpConsoleState = {
    phase: 'connecting',
    endpoint: 'the local MCP endpoint',
  }
  let snapshot: AgentConsoleSnapshot = {
    ...snapshotFor(state, executionEnvironment, agentRisk),
    revision: 0,
  }
  const listeners = new Set<(event: AgentConsoleControllerEvent) => void>()
  const commands: AgentConsoleCommands = {
    async copyPairingPrompt() {
      const session = state.sessionId === undefined ? '' : `\nSession: ${state.sessionId}`
      await navigator.clipboard.writeText(
        `Connect to the TradeScript MCP endpoint at ${state.endpoint}.${session}\nRead tradescript://sessions and discover exact controls.${agentRisk.state === 'ready' ? ` Trading is enabled on the selected ${executionEnvironment} connection.` : agentRisk.state === 'unavailable' ? ` Agent orders are blocked: ${agentRisk.message}` : agentRisk.state === 'checking' ? ' Agent orders are blocked while safety checks complete.' : ' Agent trading is disabled for this connection.'}`,
      )
    },
    async copyPrompt(promptId) {
      if (promptId !== 'inspect') return
      await navigator.clipboard.writeText(
        `Inspect the attached ${APP_NAME} session ${state.sessionId ?? ''}. Read its context and list available controls before making changes.`,
      )
    },
  }

  function publish(reason: AgentConsoleControllerChangeReason): void {
    snapshot = {
      ...snapshotFor(state, executionEnvironment, agentRisk),
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
    publishAgentRisk(next) {
      agentRisk = next
      publish('host')
    },
    destroy() {
      listeners.clear()
    },
  }
}
