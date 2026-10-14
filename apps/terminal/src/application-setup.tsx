import { invoke, isTauri } from '@tauri-apps/api/core'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { AppNotification } from './app-notifications.js'
import { loadApplicationSetupStatus } from './application-setup-status.js'
import { APP_LOGO, APP_NAME } from './branding.js'
import { ConnectionSettingsButton } from './connection-settings.js'
import { DesktopSetupToolbar } from './desktop-chrome.js'
import {
  type SetupStatus,
  sdkAccessNeedsRenewal,
  sdkAuthorizationNotice,
  sdkCredentialsNeedUpdating,
  sdkRenewalPending,
} from './sdk-authorization.js'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'
import type { WorkstationSetupState } from './workstation-startup.js'

const OPEN_SETTINGS = 'terminal:application-settings'

export interface ApplicationSettingsState {
  open: boolean
  onOpenChange: (open: boolean) => void
  content: ReactNode
  busy: boolean
}

interface ApplicationSetupContentProps {
  status: SetupStatus | undefined
  settingsMode: boolean
  replacementRequested: boolean
  credentialId: string
  credentialSecret: string
  busy: boolean
  statusError: string
  sessionExpired: boolean
  onCredentialId: (value: string) => void
  onCredentialSecret: (value: string) => void
  onActivate: () => void
  onReplace: () => void
  onCancelReplacement: () => void
  onRefresh: () => void
  onReload: () => void
  onClearCredentials: () => void
}

/** Presentation shared by first-run setup, access recovery and saved settings. */
export function ApplicationSetupContent({
  status,
  settingsMode,
  replacementRequested,
  credentialId,
  credentialSecret,
  busy,
  statusError,
  sessionExpired,
  onCredentialId,
  onCredentialSecret,
  onActivate,
  onReplace,
  onCancelReplacement,
  onRefresh,
  onReload,
  onClearCredentials,
}: ApplicationSetupContentProps) {
  const [credentialPageError, setCredentialPageError] = useState('')
  const [credentialPageAttempt, setCredentialPageAttempt] = useState(0)
  const renewing = status !== undefined && sdkRenewalPending(status.sdk)
  const recovery = status?.sdk.configured && !status.sdk.ready && !renewing
  const notice = status && sdkAuthorizationNotice(status.sdk)
  const accessNeedsRenewal = status !== undefined && sdkAccessNeedsRenewal(status.sdk)
  const credentialsNeedUpdating = status !== undefined && sdkCredentialsNeedUpdating(status.sdk)
  const showCredentials =
    !status?.sdk.configured || (recovery && credentialsNeedUpdating) || replacementRequested
  return (
    <div className={`setup-content${settingsMode ? ' setup-settings' : ''}`}>
      <div className="setup-heading">
        <img className="brand-mark" src={APP_LOGO} alt="" />
        <div>
          <strong>
            {settingsMode
              ? 'TradeScript SDK'
              : recovery
                ? 'Restore SDK access'
                : `Welcome to ${APP_NAME}`}
          </strong>
          <p>
            {settingsMode
              ? `SDK ${status?.sdk.version ?? '0.1.38'}`
              : 'Your workstation. Your broker. Your AI provider.'}
          </p>
        </div>
      </div>
      {(renewing || (recovery && !notice)) && <p role="status">Checking SDK authorization…</p>}
      {settingsMode ? (
        <section className="setup-settings-section" aria-label="SDK access">
          {status?.sdk.ready && <p className="setup-success">SDK credentials saved · Activated</p>}
          {!replacementRequested && (
            <button type="button" disabled={busy} onClick={onReplace}>
              Replace credentials
            </button>
          )}
        </section>
      ) : (
        <>
          <div className="setup-step">
            <span>01</span>
            <div>
              <strong>
                {accessNeedsRenewal
                  ? 'Restore subscription access'
                  : recovery
                    ? 'Restore SDK authorization'
                    : status?.sdk.ready
                      ? 'SDK authorized'
                      : 'Activate your SDK'}
              </strong>
              <p>
                {accessNeedsRenewal
                  ? 'Your existing SDK credentials are saved. Restore your licence coverage, then retry authorization.'
                  : recovery && !credentialsNeedUpdating
                    ? 'Your existing SDK credentials are saved. Resolve the authorization issue above, then retry.'
                    : status?.sdk.ready
                      ? 'Your SDK access is activated on this computer.'
                      : 'Enter your Client key and Secret to activate the charts library on this computer.'}
              </p>
            </div>
          </div>
          {status?.sdk.ready && <p className="setup-success">SDK credentials saved · Activated</p>}
        </>
      )}
      <p className="setup-credential-help">
        <a
          href="https://console.tradescript.dev/app/deployments/localhost"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!isTauri()) return
            event.preventDefault()
            setCredentialPageAttempt((attempt) => attempt + 1)
            setCredentialPageError('')
            void invoke('open_credentials_page').catch(() => {
              setCredentialPageError(
                'Could not open your browser. Visit console.tradescript.dev to get your credentials.',
              )
            })
          }}
        >
          Get credentials
        </a>
      </p>
      {credentialPageError && (
        <AppNotification message={credentialPageError} occurrence={credentialPageAttempt} />
      )}
      {showCredentials && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onActivate()
          }}
          className="connection-form setup-credentials"
          aria-label={status?.sdk.configured ? 'Replace SDK credentials' : 'Activate SDK'}
        >
          {replacementRequested && <strong>Replace SDK credentials</strong>}
          <label>
            Client key
            <input
              autoComplete="off"
              required
              value={credentialId}
              disabled={busy}
              onChange={(event) => onCredentialId(event.target.value)}
            />
          </label>
          <label>
            Secret
            <input
              type="password"
              autoComplete="off"
              required
              value={credentialSecret}
              disabled={busy}
              onChange={(event) => onCredentialSecret(event.target.value)}
            />
          </label>
          <div className="setup-credential-actions">
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
            {replacementRequested && (
              <button type="button" disabled={busy} onClick={onCancelReplacement}>
                Cancel replacement
              </button>
            )}
          </div>
        </form>
      )}
      {status?.sdk.configured && (
        <button type="button" disabled={busy} onClick={onClearCredentials}>
          Clear credentials
        </button>
      )}
      <p className="setup-privacy">
        Credentials stay on this computer and are sent to TradeScript only to activate and renew
        your SDK licence.
      </p>
      {!settingsMode && status?.sdk.configured && !recovery && !replacementRequested && (
        <button type="button" onClick={onReplace}>
          Update SDK credentials
        </button>
      )}
      {recovery && status?.connectionConfigured ? (
        <p>Your broker connection settings and saved workspace are preserved.</p>
      ) : settingsMode ? (
        <section
          className="setup-settings-section setup-saved-connection"
          aria-label="Saved connection"
        >
          <div>
            <strong>Connection settings saved</strong>
            <p>Manage your TWS or IB Gateway connection.</p>
          </div>
          <ConnectionSettingsButton />
        </section>
      ) : (
        <>
          <div className="setup-step">
            <span>02</span>
            <div>
              <strong>Connect your broker</strong>
              <p>
                Choose Paper or Live and TWS or IB Gateway, then connect. Advanced settings include
                a custom port. Accounts are discovered from your broker.
              </p>
            </div>
          </div>
          {status?.sdk.configured && <ConnectionSettingsButton inline />}
        </>
      )}
      {sessionExpired ? (
        <button type="button" onClick={onReload}>
          Reload workstation
        </button>
      ) : (
        (!status || statusError) && (
          <button type="button" onClick={onRefresh}>
            Retry setup
          </button>
        )
      )}
    </div>
  )
}

async function setupMutationFailureMessage(
  response: Response,
  fallback: string,
): Promise<{ message: string; sessionExpired: boolean }> {
  try {
    const result: unknown = await response.json()
    if (typeof result === 'object' && result !== null && 'error' in result) {
      const error = result.error
      if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = error.message
        if (typeof message === 'string' && message.trim())
          return {
            message,
            sessionExpired:
              response.status === 401 && 'code' in error && error.code === 'invalid-session',
          }
      }
    }
  } catch {
    // A gateway/proxy failure may return HTML or an empty body rather than JSON.
  }
  return { message: fallback, sessionExpired: response.status === 401 }
}

export function ApplicationSettingsButton() {
  return (
    <button
      type="button"
      className="chart-data-action"
      aria-label="SDK settings"
      title="SDK settings"
      onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS))}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <path d="m8 2-.5 2-1.3.8-2-.6-2 3.4 1.6 1.4v1.6L2.2 12l2 3.4 2-.6 1.3.8.5 2h4l.5-2 1.3-.8 2 .6 2-3.4-1.6-1.4V9l1.6-1.4-2-3.4-2 .6-1.3-.8-.5-2Z" />
        <circle cx="10" cy="10" r="2.6" />
      </svg>
    </button>
  )
}

export function ApplicationSetup({
  children,
}: {
  children: (setup: WorkstationSetupState, settings: ApplicationSettingsState) => ReactNode
}) {
  const [status, setStatus] = useState<SetupStatus>()
  const [error, setError] = useState('')
  const [notificationAttempt, setNotificationAttempt] = useState(0)
  const [statusError, setStatusError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const [recoveringSession, setRecoveringSession] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [replacementRequested, setReplacementRequested] = useState(false)
  const [credentialId, setCredentialId] = useState('')
  const [credentialSecret, setCredentialSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const mutationInFlight = useRef(false)
  const requestGeneration = useRef(0)
  const refreshInFlight = useRef<{ generation: number; promise: Promise<SetupStatus> }>(undefined)
  const mounted = useRef(false)
  const mock = import.meta.env.VITE_TRADING_MODE === 'mock'
  const clearReplacement = () => {
    setReplacementRequested(false)
    setCredentialId('')
    setCredentialSecret('')
    setError('')
  }
  const changeSettingsOpen = (open: boolean) => {
    if (busy) return
    if (!open) clearReplacement()
    setSettingsOpen(open)
  }
  const refresh = useCallback(async (isClosed: () => boolean = () => false) => {
    if (mock || mutationInFlight.current) return
    let request = refreshInFlight.current
    if (!request || request.generation !== requestGeneration.current) {
      const generation = ++requestGeneration.current
      request = {
        generation,
        promise: loadApplicationSetupStatus(() => {
          if (
            !mounted.current ||
            generation !== requestGeneration.current ||
            mutationInFlight.current
          )
            throw new DOMException('The setup request was superseded.', 'AbortError')
          setSessionExpired(true)
          setRecoveringSession(true)
          setStatusError('')
        }),
      }
      refreshInFlight.current = request
    }
    const { generation } = request
    try {
      const next = await request.promise
      if (
        mounted.current &&
        !isClosed() &&
        generation === requestGeneration.current &&
        !mutationInFlight.current
      ) {
        setStatus(next)
        setStatusError('')
        setSessionExpired(false)
        setRecoveringSession(false)
      }
    } catch (cause) {
      if (
        mounted.current &&
        !isClosed() &&
        generation === requestGeneration.current &&
        !mutationInFlight.current
      )
        setStatusError(cause instanceof Error ? cause.message : 'Setup is unavailable.')
    } finally {
      if (refreshInFlight.current === request) refreshInFlight.current = undefined
    }
  }, [])
  useEffect(() => {
    mounted.current = true
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
      mounted.current = false
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
    setNotificationAttempt((attempt) => attempt + 1)
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
      if (!response.ok) {
        const failure = await setupMutationFailureMessage(response, 'Could not activate the SDK.')
        setSessionExpired(failure.sessionExpired)
        throw new Error(failure.message)
      }
      clearReplacement()
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
    setNotificationAttempt((attempt) => attempt + 1)
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
      if (!response.ok) {
        const failure = await setupMutationFailureMessage(response, 'Could not restore SDK access.')
        setSessionExpired(failure.sessionExpired)
        throw new Error(failure.message)
      }
      if (status?.connectionConfigured) window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restore SDK access.')
    } finally {
      mutationInFlight.current = false
      setBusy(false)
      void refresh()
    }
  }
  const clearCredentials = async () => {
    if (mutationInFlight.current) return
    setNotificationAttempt((attempt) => attempt + 1)
    mutationInFlight.current = true
    ++requestGeneration.current
    setBusy(true)
    setError('')
    try {
      const session = await bootstrapBrowserSession()
      const response = await fetch('/api/v1/setup/sdk', {
        method: 'DELETE',
        headers: { ...CLIENT_HEADERS, 'x-tradescript-csrf': session.csrfToken },
        body: '{}',
      })
      if (!response.ok) {
        const failure = await setupMutationFailureMessage(
          response,
          'Could not clear the saved credentials.',
        )
        setSessionExpired(failure.sessionExpired)
        throw new Error(failure.message)
      }
      clearReplacement()
      setSettingsOpen(false)
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              sdk: {
                configured: false,
                ready: false,
                state: 'unconfigured',
                ...(previous.sdk.version ? { version: previous.sdk.version } : {}),
              },
            }
          : previous,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not clear the saved credentials.')
    } finally {
      mutationInFlight.current = false
      setBusy(false)
      void refresh()
    }
  }
  const settings = {
    open: settingsOpen,
    onOpenChange: changeSettingsOpen,
    content: null,
    busy,
  }
  if (mock)
    return children({ ready: true, stage: 'authorization', error: '', retry: refresh }, settings)
  // A pending renewal keeps the workstation open; recovery starts only once it fails.
  const renewing = status !== undefined && sdkRenewalPending(status.sdk)
  const complete =
    status?.sdk.configured && (status.sdk.ready || renewing) && status.connectionConfigured
  const checkingSetup =
    status === undefined ||
    (status.sdk.configured &&
      status.connectionConfigured &&
      status.sdk.state === 'exchanging' &&
      !status.sdk.failure)
  const notice = status && sdkAuthorizationNotice(status.sdk)
  const accessNeedsRenewal = status !== undefined && sdkAccessNeedsRenewal(status.sdk)
  const content = (
    <ApplicationSetupContent
      status={status}
      settingsMode={Boolean(complete)}
      replacementRequested={replacementRequested}
      credentialId={credentialId}
      credentialSecret={credentialSecret}
      busy={busy || recoveringSession}
      statusError={statusError}
      sessionExpired={sessionExpired}
      onCredentialId={setCredentialId}
      onCredentialSecret={setCredentialSecret}
      onActivate={() => void activate()}
      onReplace={() => setReplacementRequested(true)}
      onCancelReplacement={clearReplacement}
      onRefresh={() => void refresh()}
      onReload={() => window.location.reload()}
      onClearCredentials={() => void clearCredentials()}
    />
  )
  return (
    <>
      <AppNotification message={error} occurrence={notificationAttempt} />
      {!recoveringSession && status !== undefined && <AppNotification message={statusError} />}
      {recoveringSession ? (
        <AppNotification
          title="Reconnecting to local gateway"
          message={statusError || 'Your workstation session will be restored automatically.'}
          tone={statusError ? 'error' : 'info'}
          action={
            statusError ? { label: 'Retry connection', onClick: () => void refresh() } : undefined
          }
        />
      ) : complete && sessionExpired ? (
        <AppNotification
          title="Your local session expired"
          message="Reload the workstation to restore access. Your saved settings are preserved."
          action={{ label: 'Reload workstation', onClick: () => window.location.reload() }}
        />
      ) : (
        notice && (
          <AppNotification
            title={notice.title}
            message={notice.message}
            tone="warning"
            action={
              !complete || status?.sdk.failure === 'unavailable' || accessNeedsRenewal
                ? {
                    label: busy ? 'Please wait…' : 'Retry authorization',
                    disabled: busy,
                    onClick: () => void retry(),
                  }
                : {
                    label: 'Update SDK credentials',
                    onClick: () => {
                      setReplacementRequested(true)
                      setSettingsOpen(true)
                    },
                  }
            }
          />
        )
      )}
      {checkingSetup || complete ? (
        children(
          {
            ready: Boolean(complete),
            stage: status === undefined ? 'setup' : 'authorization',
            error: statusError,
            retry: refresh,
          },
          { ...settings, content },
        )
      ) : (
        <>
          <DesktopSetupToolbar />
          <main className="setup-page">
            <section className="setup-card" aria-label="Workstation setup">
              {content}
            </section>
          </main>
        </>
      )}
    </>
  )
}
