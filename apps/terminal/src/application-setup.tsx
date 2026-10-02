import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ChartUiThemeProvider, StandardModal } from '@tradescript/pro/react/ui'
import type { ChartTheme } from '@tradescript/pro/sdk'
import { chartButtonThemeStyle } from '@tradescript/pro/sdk/theme'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { ConnectionSettingsButton } from './connection-settings.js'
import { LegalNotices } from './legal-notices.js'
import {
  type SetupStatus,
  sdkAccessNeedsConsole,
  sdkAuthorizationNotice,
  sdkCredentialsNeedUpdating,
  sdkRenewalPending,
} from './sdk-authorization.js'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'
import {
  appOpeningAccountId,
  openTradeScriptConsole,
  TradeScriptAccountControls,
} from './tradescript-account.js'
import { WORKSTATION_THEME } from './workstation-theme.js'

const settingsTheme: ChartTheme = {
  ...WORKSTATION_THEME,
  ui: {
    ...WORKSTATION_THEME.ui,
    modal: {
      ...WORKSTATION_THEME.ui?.modal,
      background: 'rgba(19, 29, 42, 0.96)',
      mutedText: '#aab9cb',
    },
  },
}
const themeStyle = Object.fromEntries(
  Object.entries(chartButtonThemeStyle(settingsTheme)).filter(
    ([, value]) => typeof value === 'string' || typeof value === 'number',
  ),
)
const OPEN_SETTINGS = 'terminal:application-settings'
const LOG_OUT = 'terminal:log-out'
const SYNC_LICENSE = 'terminal:sync-license'

interface ApplicationSetupContentProps {
  status: SetupStatus | undefined
  settingsMode: boolean
  replacementRequested: boolean
  credentialId: string
  credentialSecret: string
  busy: boolean
  error: string
  statusError: string
  sessionExpired: boolean
  onCredentialId: (value: string) => void
  onCredentialSecret: (value: string) => void
  onActivate: () => void
  onRetry: () => void
  onReplace: () => void
  onCancelReplacement: () => void
  onRefresh: () => void
  onReload: () => void
  onLogin?: () => void
  onSyncLicense?: () => void
  onBuyLicense?: () => void
  onLogout?: () => void
  onVerifyMfa?: (code: string) => void
}

/** Presentation shared by first-run setup, access recovery and saved settings. */
export function ApplicationSetupContent({
  status,
  settingsMode,
  replacementRequested,
  credentialId,
  credentialSecret,
  busy,
  error,
  statusError,
  sessionExpired,
  onCredentialId,
  onCredentialSecret,
  onActivate,
  onRetry,
  onReplace,
  onCancelReplacement,
  onRefresh,
  onReload,
  onLogin,
  onSyncLicense,
  onBuyLicense,
  onLogout,
  onVerifyMfa,
}: ApplicationSetupContentProps) {
  const renewing = status !== undefined && sdkRenewalPending(status.sdk)
  const recovery = status?.sdk.configured && !status.sdk.ready && !renewing
  const notice = status && sdkAuthorizationNotice(status.sdk)
  const accessNeedsConsole = status !== undefined && sdkAccessNeedsConsole(status.sdk)
  const credentialsNeedUpdating = status !== undefined && sdkCredentialsNeedUpdating(status.sdk)
  const showCredentials =
    !status?.sdk.configured || (recovery && credentialsNeedUpdating) || replacementRequested
  return (
    <div className={`setup-content${settingsMode ? ' setup-settings' : ''}`}>
      <div className="setup-heading">
        <img className="brand-mark" src="/tradescript-mark.svg" alt="" />
        <div>
          <strong>
            {settingsMode
              ? 'TradeScript SDK'
              : recovery
                ? 'Restore SDK access'
                : 'Welcome to TradeScript'}
          </strong>
          <p>
            {settingsMode
              ? `SDK ${status?.sdk.version ?? '0.1.34'}`
              : 'Your workstation. Your broker. Your AI provider.'}
          </p>
        </div>
      </div>
      {status?.account && onLogin && onSyncLicense && onBuyLicense && onLogout && (
        <TradeScriptAccountControls
          account={status.account}
          configured={status.sdk.configured}
          busy={busy}
          onLogin={onLogin}
          onSync={onSyncLicense}
          onBuy={onBuyLicense}
          onLogout={onLogout}
          {...(onVerifyMfa ? { onVerifyMfa } : {})}
        />
      )}
      {notice && (
        <div className="setup-authorization-notice" role="alert">
          <strong>{notice.title}</strong>
          <p>{notice.message}</p>
          {accessNeedsConsole &&
            !status?.account &&
            (onBuyLicense ? (
              <button type="button" disabled={busy} onClick={onBuyLicense}>
                Buy license
              </button>
            ) : (
              <a
                href="https://console.tradescript.dev/login?mode=trader&plan=individual"
                target="_blank"
                rel="noreferrer"
              >
                Buy license
              </a>
            ))}
          <button type="button" disabled={busy} onClick={onRetry}>
            {busy ? 'Please wait…' : 'Retry authorization'}
          </button>
        </div>
      )}
      {(renewing || (recovery && !notice)) && <p role="status">Checking SDK authorization…</p>}
      {settingsMode ? (
        <section className="setup-settings-section" aria-label="SDK access">
          {status?.sdk.ready && (
            <p className="setup-success" role="status">
              SDK credentials saved · Activated
            </p>
          )}
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
                {accessNeedsConsole
                  ? 'Restore subscription access'
                  : recovery
                    ? 'Restore SDK authorization'
                    : status?.sdk.ready
                      ? 'SDK authorized'
                      : 'Activate your SDK'}
              </strong>
              <p>
                {accessNeedsConsole
                  ? 'Your existing SDK credentials are saved. Restore access in TradeScript Console, then retry authorization.'
                  : recovery && !credentialsNeedUpdating
                    ? 'Your existing SDK credentials are saved. Resolve the authorization issue above, then retry.'
                    : status?.sdk.ready
                      ? 'Your SDK access is activated on this computer.'
                      : 'Sign in to TradeScript, or enter your license credentials from TradeScript Console.'}
              </p>
            </div>
          </div>
          {status?.sdk.ready && (
            <p className="setup-success" role="status">
              SDK credentials saved · Activated
            </p>
          )}
        </>
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
            Credential ID
            <input
              autoComplete="off"
              required
              value={credentialId}
              disabled={busy}
              onChange={(event) => onCredentialId(event.target.value)}
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
            <p>Manage your TWS or IB Gateway connection and trading permissions.</p>
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
                a custom port and trading permissions. Accounts are discovered from your broker.
              </p>
            </div>
          </div>
          {status?.sdk.configured && <ConnectionSettingsButton inline />}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {statusError && <p role="alert">{statusError}</p>}
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
      <LegalNotices />
      <p className="setup-legal">
        The terminal and proprietary SDK have separate licences. Desktop distributions include both
        in their legal notices.
      </p>
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
    <>
      <button
        type="button"
        className="chart-data-action"
        onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS))}
      >
        SDK settings
      </button>
      <button
        type="button"
        className="chart-data-action"
        onClick={() => window.dispatchEvent(new Event(SYNC_LICENSE))}
      >
        Sync License
      </button>
      <button
        type="button"
        className="chart-data-action"
        onClick={() => window.dispatchEvent(new Event(LOG_OUT))}
      >
        Log out
      </button>
    </>
  )
}

export function ApplicationSetup({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus>()
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [replacementRequested, setReplacementRequested] = useState(false)
  const [credentialId, setCredentialId] = useState('')
  const [credentialSecret, setCredentialSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const mutationInFlight = useRef(false)
  const requestGeneration = useRef(0)
  const accountAction = useRef<
    (action: 'login' | 'sync' | 'logout' | 'purchase' | 'mfa', accountId?: string) => Promise<void>
  >(async () => undefined)
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
  accountAction.current = async (action, accountId) => {
    if (mutationInFlight.current) return
    mutationInFlight.current = true
    ++requestGeneration.current
    setBusy(true)
    setError('')
    try {
      const session = await bootstrapBrowserSession()
      const response = await fetch(`/api/v1/setup/account/${action}`, {
        method: action === 'purchase' ? 'GET' : 'POST',
        headers: { ...CLIENT_HEADERS, 'x-tradescript-csrf': session.csrfToken },
        ...(action === 'purchase'
          ? {}
          : {
              body: JSON.stringify(
                action === 'mfa' ? { code: accountId } : accountId ? { accountId } : {},
              ),
            }),
      })
      if (!response.ok) {
        const failure = await setupMutationFailureMessage(
          response,
          'Could not update your TradeScript account. Try again.',
        )
        setSessionExpired(failure.sessionExpired)
        throw new Error(failure.message)
      }
      const result = await response.json()
      if (action === 'login' || action === 'purchase') await openTradeScriptConsole(result.url)
      if (action === 'logout') {
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
                account: { state: 'signed-out' },
              }
            : previous,
        )
      }
      if ((action === 'sync' || action === 'mfa') && status?.connectionConfigured)
        window.location.reload()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not update your TradeScript account.',
      )
      setSettingsOpen(true)
    } finally {
      mutationInFlight.current = false
      setBusy(false)
      void refresh()
    }
  }
  useEffect(() => {
    const logout = () => void accountAction.current('logout')
    const sync = () => void accountAction.current('sync')
    window.addEventListener(LOG_OUT, logout)
    window.addEventListener(SYNC_LICENSE, sync)
    let closed = false
    let unlisten: (() => void) | undefined
    const openRequest = (urls: string[]) => {
      if (closed) return
      for (const url of urls) {
        const accountId = appOpeningAccountId(url)
        if (accountId) {
          setSettingsOpen(true)
          void accountAction.current('sync', accountId)
          break
        }
      }
    }
    if (isTauri()) {
      void listen<string[]>('deep-link://new-url', ({ payload }) => openRequest(payload))
        .then((stop) => {
          if (closed) stop()
          else unlisten = stop
        })
        .catch(() => setError('App-opening requests are unavailable. Use Sync License.'))
      void invoke<string[]>('terminal_open_requests')
        .then(openRequest)
        .catch(() => undefined)
    }
    return () => {
      closed = true
      unlisten?.()
      window.removeEventListener(LOG_OUT, logout)
      window.removeEventListener(SYNC_LICENSE, sync)
    }
  }, [])
  if (mock) return children
  // A pending renewal keeps the workstation open; recovery starts only once it fails.
  const renewing = status !== undefined && sdkRenewalPending(status.sdk)
  const complete =
    status?.sdk.configured && (status.sdk.ready || renewing) && status.connectionConfigured
  const notice = status && sdkAuthorizationNotice(status.sdk)
  const accessNeedsConsole = status !== undefined && sdkAccessNeedsConsole(status.sdk)
  const content = (
    <ApplicationSetupContent
      status={status}
      settingsMode={Boolean(complete)}
      replacementRequested={replacementRequested}
      credentialId={credentialId}
      credentialSecret={credentialSecret}
      busy={busy}
      error={error}
      statusError={statusError}
      sessionExpired={sessionExpired}
      onCredentialId={setCredentialId}
      onCredentialSecret={setCredentialSecret}
      onActivate={() => void activate()}
      onRetry={() => void retry()}
      onReplace={() => setReplacementRequested(true)}
      onCancelReplacement={clearReplacement}
      onRefresh={() => void refresh()}
      onReload={() => window.location.reload()}
      onLogin={() => void accountAction.current('login')}
      onSyncLicense={() => void accountAction.current('sync')}
      onBuyLicense={() => void accountAction.current('purchase')}
      onLogout={() => void accountAction.current('logout')}
      onVerifyMfa={(code) => void accountAction.current('mfa', code)}
    />
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
            {accessNeedsConsole && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void accountAction.current('purchase')}
              >
                Buy license
              </button>
            )}
            {error && <p>{error}</p>}
            {status?.sdk.failure === 'unavailable' || accessNeedsConsole ? (
              <button type="button" disabled={busy} onClick={() => void retry()}>
                {busy ? 'Please wait…' : 'Retry authorization'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setReplacementRequested(true)
                  setSettingsOpen(true)
                }}
              >
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
          onOpenChange={changeSettingsOpen}
          title="Application settings"
          width="540px"
          boundary="viewport"
          contentClassName="application-settings-body"
          closeLabel="Close application settings"
          headerDensity="compact"
          closeDisabled={busy}
        >
          {content}
        </StandardModal>
      )}
    </ChartUiThemeProvider>
  )
}
