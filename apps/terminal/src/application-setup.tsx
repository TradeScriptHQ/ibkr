import { ChartUiThemeProvider, StandardModal } from '@tradescript/pro/react/ui'
import { chartButtonThemeStyle } from '@tradescript/pro/sdk/theme'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { ConnectionSettingsButton } from './connection-settings.js'
import { DesktopUpdates } from './desktop-updates.js'
import { LegalNotices } from './legal-notices.js'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'
import { WORKSTATION_THEME } from './workstation-theme.js'

interface SetupStatus {
  sdk: { configured: boolean; ready: boolean; version?: string }
  connectionConfigured: boolean
}
const themeStyle = Object.fromEntries(
  Object.entries(chartButtonThemeStyle(WORKSTATION_THEME)).filter(
    ([, value]) => typeof value === 'string' || typeof value === 'number',
  ),
)
const OPEN_SETTINGS = 'terminal:application-settings'
export function ApplicationSettingsButton() {
  return (
    <button
      type="button"
      className="chart-data-action"
      onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS))}
    >
      SDK settings
    </button>
  )
}

export function ApplicationSetup({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus>()
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [credentialId, setCredentialId] = useState('')
  const [credentialSecret, setCredentialSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const mock = import.meta.env.VITE_TRADING_MODE === 'mock'
  const refresh = useCallback(async (isClosed: () => boolean = () => false) => {
    if (mock) return
    try {
      await bootstrapBrowserSession()
      const response = await fetch('/api/v1/setup', { headers: CLIENT_HEADERS })
      if (!response.ok)
        throw new Error(
          'Could not load application setup. Check that the local gateway is running.',
        )
      const next: SetupStatus = await response.json()
      if (!isClosed()) {
        setStatus(next)
        setError('')
      }
    } catch (cause) {
      if (!isClosed()) setError(cause instanceof Error ? cause.message : 'Setup is unavailable.')
    }
  }, [])
  useEffect(() => {
    let closed = false
    void refresh(() => closed)
    return () => {
      closed = true
    }
  }, [refresh])
  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener(OPEN_SETTINGS, open)
    return () => window.removeEventListener(OPEN_SETTINGS, open)
  }, [])
  const activate = async () => {
    setBusy(true)
    setError('')
    try {
      const session = await bootstrapBrowserSession()
      const response = await fetch('/api/v1/setup/sdk', {
        method: 'PUT',
        headers: { ...CLIENT_HEADERS, 'x-tradescript-csrf': session.csrfToken },
        body: JSON.stringify({ credentialId, credentialSecret }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not activate the SDK.')
      setCredentialId('')
      setCredentialSecret('')
      if (status?.connectionConfigured) window.location.reload()
      else
        setStatus({
          sdk: { configured: true, ready: true, version: '0.1.34' },
          connectionConfigured: false,
        })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not activate the SDK.')
    } finally {
      setBusy(false)
    }
  }
  if (mock) return children
  const complete = status?.sdk.configured && status.connectionConfigured
  const content = (
    <div className="setup-content">
      <div className="setup-heading">
        <span className="brand-mark">TS</span>
        <div>
          <strong>Welcome to TradeScript</strong>
          <p>Your workstation. Your broker. Your AI provider.</p>
        </div>
      </div>
      <div className="setup-step">
        <span>01</span>
        <div>
          <strong>Activate your SDK</strong>
          <p>
            TradeScript SDK {status?.sdk.version ?? '0.1.34'} is included. Enter the runtime
            credentials from Developer Console. No npm token is needed.
          </p>
        </div>
      </div>
      {status?.sdk.configured && (
        <p className="setup-success" role="status">
          SDK credentials saved{status.sdk.ready ? ' · Activated' : ''}
        </p>
      )}
      {(!status?.sdk.configured || settingsOpen) && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void activate()
          }}
          className="connection-form"
        >
          <label>
            Credential ID
            <input
              autoComplete="off"
              required
              value={credentialId}
              disabled={busy}
              onChange={(event) => setCredentialId(event.target.value)}
            />
          </label>
          <label>
            SDK secret
            <input
              type="password"
              autoComplete="off"
              required
              value={credentialSecret}
              disabled={busy}
              onChange={(event) => setCredentialSecret(event.target.value)}
            />
          </label>
          <p>
            Credentials stay on this computer and are sent to TradeScript only to activate and renew
            your SDK licence.
          </p>
          <button
            className="setup-primary"
            type="submit"
            disabled={busy || !credentialId.trim() || !credentialSecret.trim()}
          >
            {busy
              ? 'Activating…'
              : status?.sdk.configured
                ? 'Update SDK credentials'
                : 'Activate SDK'}
          </button>
        </form>
      )}
      <div className="setup-step">
        <span>02</span>
        <div>
          <strong>Connect your TWS</strong>
          <p>
            Choose Live or Paper, test your connection, and select trading permissions. Accounts are
            discovered from TWS.
          </p>
        </div>
      </div>
      {status?.sdk.configured && <ConnectionSettingsButton />}
      <div className="setup-step">
        <span>03</span>
        <div>
          <strong>Connect an agent · Optional</strong>
          <p>
            Use the Agent Console in your workspace to connect your own AI client through local MCP.
            The console provides the endpoint and pairing instructions. Your client manages its AI
            credentials.
          </p>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {!status && (
        <button type="button" onClick={() => void refresh()}>
          Retry setup
        </button>
      )}
      <LegalNotices />
      <p className="setup-legal">
        The terminal and proprietary SDK have separate licences. Desktop distributions include both
        in their legal notices.
      </p>
    </div>
  )
  return (
    <ChartUiThemeProvider theme="dark" themeStyle={themeStyle}>
      {complete ? (
        children
      ) : (
        <main className="setup-page">
          <section className="setup-card" aria-label="Workstation setup">
            <DesktopUpdates />
            {content}
          </section>
        </main>
      )}
      {complete && (
        <StandardModal
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          title="Application settings"
          width="540px"
          headerDensity="compact"
          closeDisabled={busy}
        >
          {content}
        </StandardModal>
      )}
    </ChartUiThemeProvider>
  )
}
