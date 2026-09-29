import { ChartUiThemeProvider, StandardModal } from '@tradescript/pro/react/ui'
import { chartButtonThemeStyle } from '@tradescript/pro/sdk/theme'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { ConnectionSettingsButton } from './connection-settings.js'
import { LegalNotices } from './legal-notices.js'
import { type SetupStatus, sdkAuthorizationNotice } from './sdk-authorization.js'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'
import { WORKSTATION_THEME } from './workstation-theme.js'

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
  const [statusError, setStatusError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [credentialId, setCredentialId] = useState('')
  const [credentialSecret, setCredentialSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const mutationInFlight = useRef(false)
  const requestGeneration = useRef(0)
  const mock = import.meta.env.VITE_TRADING_MODE === 'mock'
  const refresh = useCallback(async (isClosed: () => boolean = () => false) => {
    if (mock || mutationInFlight.current) return
    const generation = ++requestGeneration.current
    try {
      await bootstrapBrowserSession()
      const response = await fetch('/api/v1/setup', {
        headers: CLIENT_HEADERS,
        signal: AbortSignal.timeout(5000),
      })
      if (response.status === 401 && !isClosed() && generation === requestGeneration.current) {
        setSessionExpired(true)
        throw new Error('Your local session expired. Reload the workstation to restore access.')
      }
      if (!response.ok)
        throw new Error(
          'Could not load application setup. Check that the local gateway is running.',
        )
      const next: SetupStatus = await response.json()
      if (!isClosed() && generation === requestGeneration.current && !mutationInFlight.current) {
        setStatus(next)
        setStatusError('')
      }
    } catch (cause) {
      if (!isClosed() && generation === requestGeneration.current && !mutationInFlight.current)
        setStatusError(cause instanceof Error ? cause.message : 'Setup is unavailable.')
    }
  }, [])
  useEffect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh(() => closed)
      if (!closed) timer = setTimeout(poll, 5000)
    }
    const onFocus = () => void refresh(() => closed)
    void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      closed = true
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])
  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener(OPEN_SETTINGS, open)
    return () => window.removeEventListener(OPEN_SETTINGS, open)
  }, [])
  const activate = async () => {
    if (mutationInFlight.current) return
    mutationInFlight.current = true
    ++requestGeneration.current
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
      if (response.status === 401) setSessionExpired(true)
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not activate the SDK.')
      setCredentialId('')
      setCredentialSecret('')
      if (status?.connectionConfigured) window.location.reload()
      else
        setStatus({
          sdk: {
            configured: true,
            ready: true,
            state: 'ready',
            ...(status?.sdk.version ? { version: status.sdk.version } : {}),
          },
          connectionConfigured: false,
        })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not activate the SDK.')
    } finally {
      mutationInFlight.current = false
      setBusy(false)
    }
  }
  const retry = async () => {
    if (mutationInFlight.current) return
    mutationInFlight.current = true
    ++requestGeneration.current
    setBusy(true)
    setError('')
    try {
      const session = await bootstrapBrowserSession()
      const response = await fetch('/api/v1/setup/sdk/retry', {
        method: 'POST',
        headers: { ...CLIENT_HEADERS, 'x-tradescript-csrf': session.csrfToken },
        body: '{}',
      })
      const result = await response.json()
      if (response.status === 401) setSessionExpired(true)
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not restore SDK access.')
      if (status?.connectionConfigured) window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restore SDK access.')
    } finally {
      mutationInFlight.current = false
      setBusy(false)
      void refresh()
    }
  }
  if (mock) return children
  const complete = status?.sdk.configured && status.sdk.ready && status.connectionConfigured
  const recovery = status?.sdk.configured && !status.sdk.ready
  const notice = status && sdkAuthorizationNotice(status.sdk)
  const content = (
    <div className="setup-content">
      <div className="setup-heading">
        <img className="brand-mark" src="/tradescript-mark.svg" alt="" />
        <div>
          <strong>{recovery ? 'Restore SDK access' : 'Welcome to TradeScript'}</strong>
          <p>Your workstation. Your broker. Your AI provider.</p>
        </div>
      </div>
      {notice && (
        <div className="setup-authorization-notice" role="alert">
          <strong>{notice.title}</strong>
          <p>{notice.message}</p>
          <button type="button" disabled={busy} onClick={() => void retry()}>
            {busy ? 'Please wait…' : 'Retry authorization'}
          </button>
        </div>
      )}
      {recovery && !notice && <p role="status">Checking SDK authorization…</p>}
      <div className="setup-step">
        <span>01</span>
        <div>
          <strong>
            {status?.sdk.configured ? 'Update your SDK credentials' : 'Activate your SDK'}
          </strong>
          <p>
            TradeScript SDK {status?.sdk.version ?? '0.1.34'} is included. Enter the runtime
            credentials from Developer Console. No npm token is needed.
          </p>
        </div>
      </div>
      {status?.sdk.ready && (
        <p className="setup-success" role="status">
          SDK credentials saved{status.sdk.ready ? ' · Activated' : ''}
        </p>
      )}
      {(!status?.sdk.configured || recovery || settingsOpen) && (
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
      {status?.sdk.configured && !recovery && !settingsOpen && (
        <button type="button" onClick={() => setSettingsOpen(true)}>
          Update SDK credentials
        </button>
      )}
      {recovery && status?.connectionConfigured ? (
        <p>Your TWS connection settings and saved workspace are preserved.</p>
      ) : (
        <>
          <div className="setup-step">
            <span>02</span>
            <div>
              <strong>Connect your TWS</strong>
              <p>
                Choose Live or Paper, test your connection, and select trading permissions. Accounts
                are discovered from TWS.
              </p>
            </div>
          </div>
          {status?.sdk.configured && <ConnectionSettingsButton />}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {statusError && <p role="alert">{statusError}</p>}
      {sessionExpired ? (
        <button type="button" onClick={() => window.location.reload()}>
          Reload workstation
        </button>
      ) : (
        (!status || statusError) && (
          <button type="button" onClick={() => void refresh()}>
            Retry setup
          </button>
        )
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
      {complete && sessionExpired && !settingsOpen ? (
        <aside className="sdk-authorization-notice" role="alert">
          <strong>Your local session expired</strong>
          <p>Reload the workstation to restore access. Your saved settings are preserved.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload workstation
          </button>
        </aside>
      ) : (
        complete &&
        notice &&
        !settingsOpen && (
          <aside className="sdk-authorization-notice" role="alert">
            <strong>{notice.title}</strong>
            <p>{notice.message}</p>
            {error && <p>{error}</p>}
            {status?.sdk.failure === 'unavailable' ? (
              <button type="button" disabled={busy} onClick={() => void retry()}>
                {busy ? 'Please wait…' : 'Retry authorization'}
              </button>
            ) : (
              <button type="button" onClick={() => setSettingsOpen(true)}>
                Update SDK credentials
              </button>
            )}
          </aside>
        )
      )}
      {complete ? (
        children
      ) : (
        <main className="setup-page">
          <section className="setup-card" aria-label="Workstation setup">
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
