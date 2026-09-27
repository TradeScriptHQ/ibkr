import {
  ConnectionProfileSchema,
  type ConnectionSettings,
  type ConnectionSnapshot,
} from '@ibkr-terminal/contracts'
import { ChartUiThemeProvider, StandardModal, StandardSelect } from '@tradescript/pro/react/ui'
import { chartButtonThemeStyle } from '@tradescript/pro/sdk/theme'
import { useEffect, useState } from 'react'
import { readConnection } from './connection-client.js'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'
import { WORKSTATION_THEME } from './workstation-theme.js'

const connectionTheme = Object.fromEntries(
  Object.entries(chartButtonThemeStyle(WORKSTATION_THEME)).filter(
    ([, value]) => typeof value === 'string' || typeof value === 'number',
  ),
)

export function ConnectionSettingsButton() {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>()
  const [settings, setSettings] = useState<ConnectionSettings>()
  const [open, setOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<{ testId: string; accounts: string[] }>()
  const [error, setError] = useState('')
  useEffect(() => {
    let closed = false
    let generation: string | undefined
    const refresh = async () => {
      try {
        await bootstrapBrowserSession()
        const next = await readConnection()
        if (closed) return
        if (generation && next.generation !== generation) {
          window.location.reload()
          return
        }
        generation = next.generation
        setSnapshot(next)
        setSettings((previous) => previous ?? next.settings)
      } catch (cause) {
        if (!closed) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      closed = true
      window.clearInterval(timer)
    }
  }, [])
  const updateProfile = (patch: Partial<ConnectionSettings['profiles']['paper']>) => {
    if (!settings) return
    if (patch.port !== undefined || patch.clientId !== undefined) setTested(undefined)
    setSettings({
      ...settings,
      profiles: {
        ...settings.profiles,
        [settings.active]: { ...settings.profiles[settings.active], ...patch },
      },
    })
  }
  const testConnection = async () => {
    if (!settings || !snapshot) return
    setBusy(true)
    setTesting(true)
    setTested(undefined)
    setError('')
    try {
      const session = await bootstrapBrowserSession()
      const response = await fetch('/api/v1/connection/test', {
        method: 'POST',
        headers: { ...CLIENT_HEADERS, 'x-tradescript-csrf': session.csrfToken },
        body: JSON.stringify({ generation: snapshot.generation, settings }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? 'Could not test the connection.')
      setTested(body)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      if (/client.*(?:already|in use|duplicate)|duplicate.*client/i.test(message))
        setAdvancedOpen(true)
    } finally {
      setBusy(false)
      setTesting(false)
    }
  }
  const apply = async () => {
    if (!snapshot || !settings || !tested) return
    setBusy(true)
    setError('')
    try {
      const session = await bootstrapBrowserSession()
      const response = await fetch('/api/v1/connection', {
        method: 'PUT',
        headers: { ...CLIENT_HEADERS, 'x-tradescript-csrf': session.csrfToken },
        body: JSON.stringify({
          generation: snapshot.generation,
          testId: tested.testId,
          settings: {
            ...settings,
            profiles: {
              paper: {
                ...settings.profiles.paper,
                allowedAccountIds: settings.profiles.paper.allowedAccountIds.filter(Boolean),
              },
              live: {
                ...settings.profiles.live,
                allowedAccountIds: settings.profiles.live.allowedAccountIds.filter(Boolean),
              },
            },
          },
        }),
      })
      if (!response.ok) {
        const body = await response.json()
        throw new Error(body.error?.message ?? 'Could not change the connection.')
      }
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }
  const profile = settings?.profiles[settings.active]
  return (
    <ChartUiThemeProvider theme="dark" themeStyle={connectionTheme}>
      <button
        type="button"
        className="connection-button"
        aria-label="Connection"
        title="Connection settings"
        onClick={() => setOpen(true)}
      >
        {snapshot ? (
          <>
            <span className="connection-mode" data-mode={snapshot.settings.active}>
              <span className="connection-mode-dot" aria-hidden="true" />
              {snapshot.settings.active === 'live' ? 'Live' : 'Paper'}
            </span>
            <span className="connection-endpoint">
              TWS <span>{snapshot.settings.profiles[snapshot.settings.active].port}</span>
            </span>
          </>
        ) : (
          <span>Connection</span>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      <StandardModal
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
        title="Connection"
        width="460px"
        headerDensity="compact"
        closeDisabled={busy}
        contentClassName="connection-form"
        footer={
          <div className="connection-actions">
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Close
            </button>
            <button
              type="button"
              disabled={busy || !settings}
              onClick={() => void testConnection()}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button
              type="button"
              disabled={busy || !settings || !tested}
              onClick={() => void apply()}
            >
              {busy && !testing ? 'Connecting…' : 'Apply and connect'}
            </button>
          </div>
        }
      >
        {settings && profile && (
          <>
            <div className="connection-select-field">
              <span>Mode</span>
              <StandardSelect
                ariaLabel="Mode"
                size="sm"
                value={settings.active}
                disabled={busy}
                options={[
                  { value: 'paper', label: 'Paper' },
                  { value: 'live', label: 'Live' },
                ]}
                onChange={(value) => {
                  setTested(undefined)
                  setSettings({ ...settings, active: value === 'live' ? 'live' : 'paper' })
                }}
              />
            </div>
            {tested && (
              <div className="connection-test-result" role="status">
                <strong>Connection successful</strong>
                <span>Accounts from TWS: {tested.accounts.join(', ')}</span>
              </div>
            )}
            <div className="connection-select-field">
              <span>Permissions</span>
              <StandardSelect
                ariaLabel="Permissions"
                size="sm"
                value={profile.permission}
                disabled={busy}
                options={[
                  { value: 'read-only', label: 'Read-only' },
                  { value: 'manual', label: 'Manual trading' },
                  { value: 'agent', label: 'Manual and agent trading' },
                ]}
                onChange={(value) => {
                  if (value === 'read-only' || value === 'manual' || value === 'agent')
                    updateProfile({ permission: value })
                }}
              />
            </div>
            {profile.permission === 'agent' && (
              <AgentLimitsFields
                key={settings.active}
                limits={profile.limits}
                onChange={(limits) => updateProfile({ limits })}
              />
            )}
            <details
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>Advanced settings</summary>
              <label>
                Port
                <input
                  type="number"
                  min="1"
                  max="65535"
                  required
                  disabled={busy}
                  value={profile.port}
                  onChange={(event) => updateProfile({ port: event.target.valueAsNumber })}
                />
              </label>
              <label>
                Client ID
                <input
                  type="number"
                  min="0"
                  required
                  disabled={busy}
                  value={profile.clientId}
                  onChange={(event) => updateProfile({ clientId: event.target.valueAsNumber })}
                />
              </label>
              <p>
                Each app connected to TWS needs a unique Client ID. Keep the saved ID to retain
                order ownership.
              </p>
            </details>
            <p>
              Test the connection to discover your TWS accounts, then apply to connect. Settings are
              saved separately for each mode.
            </p>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </StandardModal>
    </ChartUiThemeProvider>
  )
}

const LIMIT_LABELS = {
  maxOrderQuantity: 'Maximum order quantity',
  maxOrderNotional: 'Maximum order value',
  maxPositionQuantity: 'Maximum position quantity',
  maxPositionNotional: 'Maximum position value',
  maxDailyLoss: 'Maximum daily loss',
  maxOrdersPerMinute: 'Maximum orders per minute',
  maxEstimatedSlippageBps: 'Maximum slippage (basis points)',
  maxMarketDataAgeMs: 'Maximum quote age (milliseconds)',
  maxLeverage: 'Maximum leverage',
  maxUnprotectedPositionQuantity: 'Maximum unprotected position quantity',
} as const

type AgentLimits = NonNullable<ConnectionSettings['profiles']['paper']['limits']>
function AgentLimitsFields({
  limits,
  onChange,
}: {
  limits: AgentLimits | undefined
  onChange: (limits: AgentLimits | undefined) => void
}) {
  const [draft, setDraft] = useState<Partial<AgentLimits>>(limits ?? {})
  return (
    <details open={!limits}>
      <summary>Advanced · Agent limits</summary>
      <p>Choose the limits agents may trade within. Values are saved for this mode.</p>
      {(Object.keys(LIMIT_LABELS) as Array<keyof typeof LIMIT_LABELS>).map((key) => (
        <label key={key}>
          {LIMIT_LABELS[key]}
          <input
            type="number"
            min="0"
            step="any"
            value={draft[key] ?? ''}
            onChange={(event) => {
              const next = { ...draft, [key]: event.target.valueAsNumber }
              setDraft(next)
              const parsed = ConnectionProfileSchema.shape.limits.unwrap().safeParse(next)
              onChange(parsed.success ? parsed.data : undefined)
            }}
          />
        </label>
      ))}
    </details>
  )
}
