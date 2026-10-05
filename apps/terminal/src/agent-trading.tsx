import {
  AGENT_LIMIT_PRESETS,
  type AgentRiskLimits,
  AgentRiskLimitsSchema,
  type ConnectionSnapshot,
  ConnectionSnapshotSchema,
  matchingAgentLimitPreset,
} from '@ibkr-terminal/contracts'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AppNotification } from './app-notifications.js'
import { AppModal } from './appearance-ui.js'
import { readConnection } from './connection-client.js'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'
import type { AgentRiskAvailability } from './workstation-agent-risk.js'

const LIMIT_LABELS = {
  maxOrderNotional: 'Maximum order value',
  maxPositionNotional: 'Maximum position value',
  maxGrossExposure: 'Maximum gross account exposure',
  maxDailyLoss: 'Maximum daily loss',
  maxOrdersPerMinute: 'Maximum orders per minute',
  maxEstimatedSlippageBps: 'Maximum slippage (basis points)',
  maxMarketDataAgeMs: 'Maximum quote age (milliseconds)',
  maxLeverage: 'Maximum leverage',
} as const
const formatLimit = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })

function policyKey(snapshot: ConnectionSnapshot): string {
  const profile = snapshot.settings.profiles[snapshot.settings.active]
  return JSON.stringify([snapshot.generation, profile.agentTradingEnabled, profile.limits])
}

function AgentRiskWarning({ message, onRetry }: { message: string; onRetry: () => void }) {
  const tooltipId = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const visible = (hovered || focused) && !dismissed
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Tracks pointer presence over the button and tooltip; the button owns keyboard and click interaction.
    <span
      className="agent-risk-warning"
      onMouseEnter={() => {
        setHovered(true)
        setDismissed(false)
      }}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="agent-risk-warning-button"
        aria-label="Agent trading paused"
        aria-describedby={visible ? tooltipId : undefined}
        onClick={onRetry}
        onFocus={() => {
          setFocused(true)
          setDismissed(false)
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDismissed(true)
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8.7 3.6a1.5 1.5 0 0 1 2.6 0l6.6 11.5a1.5 1.5 0 0 1-1.3 2.3H3.4a1.5 1.5 0 0 1-1.3-2.3Z" />
          <path d="M10 7v4M10 14h.01" />
        </svg>
      </button>
      {visible && (
        <span id={tooltipId} className="agent-risk-tooltip" role="tooltip">
          <strong>Agent trading paused</strong>
          <span>{message} Agent orders are blocked.</span>
          <span className="agent-risk-tooltip-hint">Click to retry agent checks.</span>
        </span>
      )}
    </span>
  )
}

export function AgentTradingButton({
  onChanged,
  agentRisk,
}: {
  onChanged: () => void
  agentRisk: AgentRiskAvailability | undefined
}) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notificationAttempt, setNotificationAttempt] = useState(0)
  const [pollError, setPollError] = useState('')
  const [open, setOpen] = useState(false)
  const [enableOnSave, setEnableOnSave] = useState(false)
  const [draft, setDraft] = useState<Partial<AgentRiskLimits>>({})
  const [editorGeneration, setEditorGeneration] = useState('')
  const [editorRevision, setEditorRevision] = useState(0)
  const saving = useRef(false)
  const revision = useRef(0)
  const appliedPolicy = useRef<string | undefined>(undefined)
  const commit = useCallback(
    (next: ConnectionSnapshot) => {
      const key = policyKey(next)
      const changed = appliedPolicy.current !== key
      appliedPolicy.current = key
      setSnapshot(next)
      if (changed) onChanged()
    },
    [onChanged],
  )
  useEffect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      const startedRevision = revision.current
      try {
        await bootstrapBrowserSession()
        const next = await readConnection()
        if (!closed && !saving.current && startedRevision === revision.current) {
          commit(next)
          setPollError('')
        }
      } catch {
        if (!closed) setPollError('Agent trading settings are unavailable.')
      } finally {
        if (!closed) timer = setTimeout(() => void refresh(), 2000)
      }
    }
    void refresh()
    return () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [commit])

  const profile = snapshot?.settings.profiles[snapshot.settings.active]
  const enabled = profile?.agentTradingEnabled ?? false
  const hasAccounts = (profile?.allowedAccountIds.length ?? 0) > 0
  const configured = profile?.limits !== undefined && hasAccounts
  const parsedLimits = AgentRiskLimitsSchema.safeParse(draft)
  const selectedPreset = matchingAgentLimitPreset(draft)
  const editLimits = (enable: boolean) => {
    if (!snapshot || !profile) return
    setDraft({
      ...(profile.limits ?? AGENT_LIMIT_PRESETS[0].limits),
      maxOrderQuantity: null,
      maxPositionQuantity: null,
      maxUnprotectedPositionQuantity: null,
    })
    setEditorGeneration(snapshot.generation)
    setEditorRevision(snapshot.agentTradingRevision ?? 0)
    setEnableOnSave(enable)
    setError('')
    setOpen(true)
  }
  const save = async (nextEnabled: boolean, limits?: AgentRiskLimits) => {
    if (!snapshot || saving.current) return
    setNotificationAttempt((attempt) => attempt + 1)
    saving.current = true
    revision.current += 1
    setBusy(true)
    setError('')
    try {
      const session = await bootstrapBrowserSession()
      const response = await fetch('/api/v1/connection/agent-trading', {
        method: 'PUT',
        headers: { ...CLIENT_HEADERS, 'x-tradescript-csrf': session.csrfToken },
        body: JSON.stringify({
          generation: open ? editorGeneration : snapshot.generation,
          expectedAgentTradingRevision: open
            ? editorRevision
            : (snapshot.agentTradingRevision ?? 0),
          enabled: nextEnabled,
          ...(limits === undefined ? {} : { limits }),
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? 'Could not update agent trading.')
      commit(ConnectionSnapshotSchema.parse(body))
      setPollError('')
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update agent trading.')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <div className="agent-trading-control">
        {configured ? (
          <button
            type="button"
            className="agent-trading-switch"
            role="switch"
            aria-label="Agent trading"
            aria-checked={enabled}
            aria-busy={busy}
            disabled={busy || !snapshot || Boolean(pollError)}
            title={pollError || `Turn agent trading ${enabled ? 'off' : 'on'}`}
            onClick={() => void save(!enabled)}
          >
            <span className="agent-trading-label">Agent trading</span>
            <span className="agent-trading-track" aria-hidden="true">
              <span />
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="agent-trading-setup"
            disabled={busy || !snapshot || Boolean(pollError)}
            title={pollError || 'Set up agent trading'}
            onClick={() => editLimits(true)}
          >
            Setup agent
          </button>
        )}
        {agentRisk?.state === 'checking' && (
          <span
            className="agent-risk-pending"
            role="status"
            title="Agent orders are blocked while safety checks complete."
          >
            Checking agent…
          </span>
        )}
        {agentRisk?.state === 'unavailable' && (
          <AgentRiskWarning message={agentRisk.message} onRetry={onChanged} />
        )}
        {configured && (
          <button
            type="button"
            className="agent-trading-limits-button"
            aria-label="Agent trading limits"
            title="Agent trading limits"
            disabled={busy || !snapshot || Boolean(pollError)}
            onClick={() => editLimits(false)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4" />
            </svg>
          </button>
        )}
        <AppNotification message={error || pollError} occurrence={notificationAttempt} />
      </div>
      <AppModal
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
        title="Agent trading limits"
        width="560px"
        headerDensity="compact"
        closeDisabled={busy}
        contentClassName="connection-form agent-limits-form"
        footer={
          <div className="connection-actions">
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={
                busy ||
                (enableOnSave && !hasAccounts) ||
                !parsedLimits.success ||
                snapshot?.generation !== editorGeneration ||
                (snapshot?.agentTradingRevision ?? 0) !== editorRevision
              }
              onClick={() => {
                if (parsedLimits.success) void save(enableOnSave || enabled, parsedLimits.data)
              }}
            >
              {busy ? 'Saving…' : enableOnSave ? 'Save and enable' : 'Save limits'}
            </button>
          </div>
        }
      >
        {enableOnSave && !hasAccounts && (
          <p role="status">
            Connect your broker in Connection settings, then return to finish setup.
          </p>
        )}
        <div className="agent-presets" role="radiogroup" aria-label="Limit preset">
          <span className="agent-presets-label">Limit preset</span>
          {AGENT_LIMIT_PRESETS.map((preset) => (
            <label className="agent-preset" key={preset.id}>
              <span className="agent-preset-heading">
                <input
                  type="radio"
                  name="agent-limit-preset"
                  aria-label={preset.label}
                  checked={selectedPreset === preset.id}
                  disabled={busy}
                  onChange={() => setDraft({ ...preset.limits })}
                />
                <strong>{preset.label}</strong>
              </span>
              <span>{formatLimit(preset.limits.maxOrderNotional)} per order</span>
            </label>
          ))}
        </div>
        {!selectedPreset && <p className="agent-limits-custom">Custom limits</p>}
        <p>Amounts use your broker account’s currency.</p>
        <div className="agent-limits-fields">
          {(Object.keys(LIMIT_LABELS) as Array<keyof typeof LIMIT_LABELS>).map((key) => (
            <label key={key}>
              <span className="agent-limit-label">
                {LIMIT_LABELS[key]}
                {key === 'maxGrossExposure' && <span>Optional</span>}
              </span>
              <input
                type="number"
                disabled={busy}
                min="0"
                step={key === 'maxOrdersPerMinute' ? '1' : 'any'}
                value={draft[key] ?? ''}
                onChange={(event) => {
                  const value = event.target.valueAsNumber
                  setDraft((previous) => ({
                    ...previous,
                    [key]: Number.isFinite(value) ? value : undefined,
                  }))
                }}
              />
            </label>
          ))}
        </div>
        {(snapshot?.generation !== editorGeneration ||
          (snapshot?.agentTradingRevision ?? 0) !== editorRevision) && (
          <AppNotification message="The agent settings changed. Close and reopen agent trading limits." />
        )}
      </AppModal>
    </>
  )
}
