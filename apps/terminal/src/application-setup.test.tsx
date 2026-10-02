import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationSetupContent } from './application-setup.js'
import type { SetupStatus } from './sdk-authorization.js'

vi.mock('./connection-settings.js', () => ({
  ConnectionSettingsButton: () => <button type="button">Connection</button>,
}))
vi.mock('./legal-notices.js', () => ({
  LegalNotices: () => (
    <details>
      <summary>Licences and data information</summary>
    </details>
  ),
}))

const ready: SetupStatus = {
  sdk: { configured: true, ready: true, state: 'ready', version: '0.1.34' },
  connectionConfigured: true,
}
const noop = () => undefined
function content(status: SetupStatus, settingsMode = false, replacementRequested = false) {
  return renderToStaticMarkup(
    <ApplicationSetupContent
      status={status}
      settingsMode={settingsMode}
      replacementRequested={replacementRequested}
      credentialId=""
      credentialSecret=""
      busy={false}
      error=""
      statusError=""
      sessionExpired={false}
      onCredentialId={noop}
      onCredentialSecret={noop}
      onActivate={noop}
      onRetry={noop}
      onReplace={noop}
      onCancelReplacement={noop}
      onRefresh={noop}
      onReload={noop}
    />,
  )
}

describe('application setup presentation', () => {
  it('shows compact saved settings without onboarding, restoration or credential fields', () => {
    const html = content(ready, true)
    expect(html).toContain('SDK credentials saved · Activated')
    expect(html).toContain('SDK 0.1.34')
    expect(html).toContain('Connection settings saved')
    expect(html).toContain('Replace credentials')
    expect(html).not.toMatch(/Welcome|Restore|Connect your broker|<form|<input/u)
    expect(html).toContain('Licences and data information')
    expect(html).toContain('separate licences')
    expect(html).toContain('sent to TradeScript only to activate and renew')
  })

  it('shows blank replacement fields only after an explicit request', () => {
    const html = content(ready, true, true)
    expect(html).toContain('aria-label="Replace SDK credentials"')
    expect(html).toContain('Credential ID')
    expect(html).toMatch(/type="password"[^>]*value=""/u)
    expect(html).toContain('autoComplete="off"')
    expect(html).toContain('Cancel replacement')
    expect(html).toMatch(/type="submit" disabled=""/u)
    expect(html).not.toMatch(/Welcome|Restore/u)
  })

  it('preserves first-run activation and connection steps', () => {
    const html = content({ sdk: { configured: false, ready: false }, connectionConfigured: false })
    expect(html).toContain('Welcome to TradeScript')
    expect(html).toContain('Activate your SDK')
    expect(html).toContain('Connect your broker')
    expect(html).toContain('No npm token is needed.')
    expect(html).toContain('aria-label="Activate SDK"')
    expect(html).not.toContain('Cancel replacement')
  })

  it('keeps successful SDK activation visible while broker setup remains incomplete', () => {
    const html = content({ ...ready, connectionConfigured: false })
    expect(html).toContain('Welcome to TradeScript')
    expect(html).toContain('SDK authorized')
    expect(html).toContain('SDK credentials saved · Activated')
    expect(html).toContain('Connect your broker')
    expect(html).not.toMatch(/Restore|<input/u)
  })

  it('opens replacement fields during rejected-credential recovery and preserves saved workspace', () => {
    const html = content({
      ...ready,
      sdk: { ...ready.sdk, ready: false, failure: 'rejected', failureReason: 'unauthorized' },
    })
    expect(html).toContain('Restore SDK access')
    expect(html).toContain('SDK credentials need updating')
    expect(html).toContain('Credential ID')
    expect(html).toContain('Your broker connection settings and saved workspace are preserved.')
    expect(html).not.toContain('Welcome to TradeScript')
  })

  it('keeps saved credentials during a network recovery instead of asking for replacement', () => {
    const html = content({ ...ready, sdk: { ...ready.sdk, ready: false, failure: 'unavailable' } })
    expect(html).toContain('Restore SDK access')
    expect(html).toContain('Retry authorization')
    expect(html).toContain('Your existing SDK credentials are saved.')
    expect(html).not.toContain('<input')
  })

  it('directs expired subscription access to Developer Console without replacing credentials', () => {
    const html = content({
      ...ready,
      sdk: {
        ...ready.sdk,
        ready: false,
        failure: 'rejected',
        failureReason: 'subscription_access_expired',
      },
    })
    expect(html).toContain('Subscription access has ended')
    expect(html).toContain('https://console.tradescript.dev')
    expect(html).toContain('Restore subscription access')
    expect(html).not.toContain('<input')
  })

  it('does not claim activation or show recovery while an overdue renewal is pending', () => {
    const html = content(
      {
        ...ready,
        sdk: { ...ready.sdk, ready: false, state: 'exchanging', expiresAt: '2026-10-01T00:00:00Z' },
      },
      true,
    )
    expect(html).toContain('Checking SDK authorization')
    expect(html).toContain('Replace credentials')
    expect(html).not.toMatch(/Activated|Restore|Welcome|<input/u)
  })
})
