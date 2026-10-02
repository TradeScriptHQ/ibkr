import { invoke, isTauri } from '@tauri-apps/api/core'
import { useState } from 'react'
import type { SetupStatus } from './sdk-authorization.js'

export function appOpeningAccountId(value: string): string | undefined {
  try {
    const url = new URL(value)
    const accountId = url.searchParams.get('accountId')
    if (
      url.protocol !== 'tradescript-terminal:' ||
      url.hostname !== 'sync-license' ||
      !['', '/'].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.searchParams.size !== 1 ||
      !accountId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(accountId)
    )
      return undefined
    return accountId
  } catch {
    return undefined
  }
}

export async function openTradeScriptConsole(url: string): Promise<void> {
  if (isTauri()) await invoke('open_tradescript_console', { url })
  else {
    const opened = window.open(url, '_blank', 'noopener,noreferrer')
    // Browsers may return null for a successfully opened noopener tab.
    if (opened) opened.opener = null
  }
}

export function terminalLicenseLabel(account: SetupStatus['account'], now = Date.now()): string {
  const license = account?.license
  if (!license) return ''
  if (license.status === 'expired')
    return license.kind === 'trial' ? 'Free trial · Expired' : 'License expired'
  if (license.status === 'not-provisioned') return 'No license yet'
  if (license.status === 'pending') return 'Preparing your license…'
  if (license.status !== 'active') return 'License needs attention'
  if (license.kind === 'trial' && license.trialEndsAt) {
    const days = Math.max(0, Math.ceil((Date.parse(license.trialEndsAt) - now) / 86400000))
    if (days === 0) return 'Free trial · Expired'
    return `Free trial · ${Math.min(days, license.trialDays)} of ${license.trialDays} days remaining`
  }
  return license.plan === 'individual'
    ? 'TradeScript Charts Individual · Active'
    : 'TradeScript Charts license · Active'
}

export function TradeScriptAccountControls({
  account,
  configured,
  busy,
  onLogin,
  onSync,
  onBuy,
  onLogout,
  onVerifyMfa,
}: {
  account: SetupStatus['account']
  configured: boolean
  busy: boolean
  onLogin: () => void
  onSync: () => void
  onBuy: () => void
  onLogout: () => void
  onVerifyMfa?: (code: string) => void
}) {
  const [mfaCode, setMfaCode] = useState('')
  if (!account) return null
  const signedIn = account.state === 'signed-in'
  const signingIn = account.state === 'authenticating'
  const mfaRequired = account.state === 'mfa-required'
  const licensed = account.license?.status === 'active' && account.license.kind === 'paid'
  return (
    <section className="setup-settings-section setup-account" aria-label="TradeScript account">
      <strong>
        {signedIn ? (account.account?.email ?? 'Signed in to TradeScript') : 'TradeScript account'}
      </strong>
      {terminalLicenseLabel(account) && <p>{terminalLicenseLabel(account)}</p>}
      {account.message && <p role="status">{account.message}</p>}
      <div className="setup-account-actions">
        {!signedIn && !signingIn && !mfaRequired && (
          <button type="button" className="setup-primary" disabled={busy} onClick={onLogin}>
            Log in to TradeScript
          </button>
        )}
        {signedIn && (
          <button type="button" disabled={busy} onClick={onSync}>
            Sync License
          </button>
        )}
        {!licensed && !mfaRequired && (
          <button
            type="button"
            className={account.license?.status === 'expired' ? 'setup-primary' : undefined}
            disabled={busy}
            onClick={onBuy}
          >
            Buy license
          </button>
        )}
        {(configured || signedIn || signingIn || mfaRequired || account.state === 'error') && (
          <button type="button" disabled={busy} onClick={onLogout}>
            {signingIn ? 'Cancel sign-in' : 'Log out'}
          </button>
        )}
      </div>
      {mfaRequired && onVerifyMfa && (
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault()
            onVerifyMfa(mfaCode)
            setMfaCode('')
          }}
        >
          <label>
            Authenticator code
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={mfaCode}
              disabled={busy}
              onChange={(event) => setMfaCode(event.target.value)}
              required
            />
          </label>
          <button
            type="submit"
            className="setup-primary"
            disabled={busy || !/^\d{6}$/u.test(mfaCode)}
          >
            Verify and continue
          </button>
        </form>
      )}
      {!signedIn && !signingIn && !mfaRequired && (
        <p>
          Sign in with the account used in TradeScript Console, or enter your license credentials
          below.
        </p>
      )}
    </section>
  )
}
