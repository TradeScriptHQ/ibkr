import {
  type ConnectionSettings,
  ConnectionSettingsSchema,
  type ConnectionSnapshot,
  connectionTypeLabel,
  defaultConnectionPort,
} from '@ibkr-terminal/contracts'
import { StandardSelect } from '@tradescript/pro/react/ui'
import { useEffect, useState } from 'react'
import { AppNotification } from './app-notifications.js'
import { AppModal } from './appearance-ui.js'
import { readConnection } from './connection-client.js'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'

/** Opens the toolbar connection dialog from elsewhere, such as the status popover. */
export const OPEN_CONNECTION_SETTINGS = 'terminal:connection-settings'

export function ConnectionSettingsButton({ inline = false }: { inline?: boolean }) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>()
  const [settings, setSettings] = useState<ConnectionSettings>()
  const [open, setOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<{ testId: string; accounts: string[] }>()
  const [error, setError] = useState('')
  const [notificationAttempt, setNotificationAttempt] = useState(0)
  const [pollError, setPollError] = useState('')
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
        setPollError('')
        setSettings((previous) =>
          previous
            ? {
                ...previous,
                profiles: {
                  paper: {
                    ...previous.profiles.paper,
                    agentTradingEnabled: next.settings.profiles.paper.agentTradingEnabled,
                    limits: next.settings.profiles.paper.limits,
                  },
                  live: {
                    ...previous.profiles.live,
                    agentTradingEnabled: next.settings.profiles.live.agentTradingEnabled,
                    limits: next.settings.profiles.live.limits,
                  },
                },
              }
            : next.settings,
        )
      } catch (cause) {
        if (!closed) setPollError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      closed = true
      window.clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    if (inline) return
    const openSettings = () => setOpen(true)
    window.addEventListener(OPEN_CONNECTION_SETTINGS, openSettings)
    return () => window.removeEventListener(OPEN_CONNECTION_SETTINGS, openSettings)
  }, [inline])
  const updateProfile = (patch: Partial<ConnectionSettings['profiles']['paper']>) => {
    if (!settings) return
    if (
      patch.port !== undefined ||
      patch.clientId !== undefined ||
      patch.connectionType !== undefined
    )
      setTested(undefined)
    setError('')
    setSettings({
      ...settings,
      profiles: {
        ...settings.profiles,
        [settings.active]: { ...settings.profiles[settings.active], ...patch },
      },
    })
  }
  const showFailure = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    setError(message)
    if (/client.*(?:already|in use|duplicate)|duplicate.*client/i.test(message)) {
      setAdvancedOpen(true)
      setOpen(true)
    }
  }
  const discoverAccounts = async () => {
    if (!settings || !snapshot) throw new Error('Connection settings are unavailable.')
    const session = await bootstrapBrowserSession()
    const response = await fetch('/api/v1/connection/test', {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'x-tradescript-csrf': session.csrfToken },
      body: JSON.stringify({ generation: snapshot.generation, settings }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error?.message ?? 'Could not test the connection.')
    return body as { testId: string; accounts: string[] }
  }
  const testConnection = async () => {
    setNotificationAttempt((attempt) => attempt + 1)
    setBusy(true)
    setTesting(true)
    setTested(undefined)
    setError('')
    try {
      setTested(await discoverAccounts())
    } catch (cause) {
      showFailure(cause)
    } finally {
      setBusy(false)
      setTesting(false)
    }
  }
  const apply = async (proof = tested) => {
    if (!snapshot || !settings || !proof) return
    setNotificationAttempt((attempt) => attempt + 1)
    setBusy(true)
    setError('')
    try {
      const session = await bootstrapBrowserSession()
      const response = await fetch('/api/v1/connection', {
        method: 'PUT',
        headers: { ...CLIENT_HEADERS, 'x-tradescript-csrf': session.csrfToken },
        body: JSON.stringify({
          generation: snapshot.generation,
          testId: proof.testId,
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
      showFailure(cause)
      setBusy(false)
    }
  }
  const connect = async () => {
    setNotificationAttempt((attempt) => attempt + 1)
    setBusy(true)
    setTesting(true)
    setTested(undefined)
    setError('')
    try {
      const proof = await discoverAccounts()
      setTested(proof)
      setTesting(false)
      await apply(proof)
    } catch (cause) {
      showFailure(cause)
      setBusy(false)
      setTesting(false)
    }
  }
  const profile = settings?.profiles[settings.active]
  const valid = settings !== undefined && ConnectionSettingsSchema.safeParse(settings).success
  const defaultPort =
    settings && profile && defaultConnectionPort(settings.active, profile.connectionType)
  const portHint = profile && (
    <p className="connection-port-hint">
      {profile.port === defaultPort ? 'Default port' : 'Custom port'} ·{' '}
      {Number.isFinite(profile.port) ? profile.port : 'Enter a valid port in Advanced'}
    </p>
  )
  const endpointFields = settings && profile && (
    <>
      <div className="connection-select-field">
        <span>Trading mode</span>
        <StandardSelect
          ariaLabel="Trading mode"
          size={inline ? 'md' : 'sm'}
          value={settings.active}
          disabled={busy}
          options={[
            { value: 'paper', label: 'Paper' },
            { value: 'live', label: 'Live' },
          ]}
          onChange={(value) => {
            setTested(undefined)
            setError('')
            setSettings({ ...settings, active: value === 'live' ? 'live' : 'paper' })
          }}
        />
      </div>
      <div className="connection-select-field">
        <span>Connection</span>
        <StandardSelect
          ariaLabel="Connection type"
          size={inline ? 'md' : 'sm'}
          value={profile.connectionType}
          disabled={busy}
          options={[
            { value: 'tws', label: 'TWS' },
            { value: 'ib-gateway', label: 'IB Gateway' },
          ]}
          onChange={(value) => {
            if (value === 'tws' || value === 'ib-gateway')
              updateProfile({
                connectionType: value,
                port: defaultConnectionPort(settings.active, value),
              })
          }}
        />
      </div>
    </>
  )
  return (
    <>
      <AppNotification message={error || pollError} occurrence={notificationAttempt} />
      {tested && (
        <AppNotification
          message="Connection successful."
          tone="success"
          occurrence={notificationAttempt}
        />
      )}
      {inline ? (
        <div className="connection-setup">
          <div className="connection-setup-controls">
            {endpointFields}
            <button
              type="button"
              disabled={busy || !settings}
              onClick={() => {
                setAdvancedOpen(true)
                setOpen(true)
              }}
            >
              Advanced
            </button>
            <button
              type="button"
              className="setup-primary"
              disabled={busy || !valid || !snapshot}
              onClick={() => void connect()}
            >
              {busy ? (testing ? 'Testing…' : 'Connecting…') : 'Connect'}
            </button>
          </div>
          {portHint}
        </div>
      ) : (
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
                {connectionTypeLabel(
                  snapshot.settings.profiles[snapshot.settings.active].connectionType,
                )}{' '}
                <span>{snapshot.settings.profiles[snapshot.settings.active].port}</span>
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
      )}
      <AppModal
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
              disabled={busy || !valid || !snapshot}
              onClick={() => void testConnection()}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" disabled={busy || !valid || !tested} onClick={() => void apply()}>
              {busy && !testing ? 'Connecting…' : 'Apply and connect'}
            </button>
          </div>
        }
      >
        {settings && profile && (
          <>
            {endpointFields}
            {portHint}
            {tested && (
              <div className="connection-test-result">
                <strong>Discovered accounts</strong>
                <span>
                  Accounts from {connectionTypeLabel(profile.connectionType)}:{' '}
                  {tested.accounts.join(', ')}
                </span>
              </div>
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
                  value={Number.isFinite(profile.port) ? profile.port : ''}
                  onChange={(event) => updateProfile({ port: event.target.valueAsNumber })}
                />
              </label>
              <button
                type="button"
                disabled={busy || profile.port === defaultPort}
                onClick={() =>
                  updateProfile({
                    port: defaultConnectionPort(settings.active, profile.connectionType),
                  })
                }
              >
                Use default port
              </button>
              <p>
                Default for {settings.active === 'live' ? 'Live' : 'Paper'}{' '}
                {connectionTypeLabel(profile.connectionType)}: {defaultPort}. A custom port must
                match the socket port in your broker app.
              </p>
              <label>
                Client ID
                <input
                  type="number"
                  min="0"
                  required
                  disabled={busy}
                  value={Number.isFinite(profile.clientId) ? profile.clientId : ''}
                  onChange={(event) => updateProfile({ clientId: event.target.valueAsNumber })}
                />
              </label>
              <p>
                Each app connected to TWS or IB Gateway needs a unique Client ID. Keep the saved ID
                to retain order ownership.
              </p>
            </details>
            <p>
              Test the connection to discover your broker accounts, then apply to connect. Settings
              are saved separately for each mode.
            </p>
          </>
        )}
      </AppModal>
    </>
  )
}
