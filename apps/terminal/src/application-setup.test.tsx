import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationSetupContent } from './application-setup.js'
import type { SetupStatus } from './sdk-authorization.js'

vi.mock('./connection-settings.js', () => ({
  ConnectionSettingsButton: () => <button type="button">Connection</button>,
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
      statusError=""
      sessionExpired={false}
      onCredentialId={noop}
      onCredentialSecret={noop}
      onActivate={noop}
      onReplace={noop}
      onCancelReplacement={noop}
      onRefresh={noop}
      onReload={noop}
      onClearCredentials={noop}
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
    expect(html).toContain('Clear credentials')
    expect(html).not.toMatch(/Welcome|Restore|Connect your broker|<form|<input/u)
    expect(html).not.toMatch(/Licences and data information|separate licences/u)
    expect(html).toContain('sent to TradeScript only to activate and renew')
  })

  it('shows blank replacement fields only after an explicit request', () => {
    const html = content(ready, true, true)
    expect(html).toContain('aria-label="Replace SDK credentials"')
    expect(html).toContain('Client key')
    expect(html).toMatch(/type="password"[^>]*value=""/u)
    expect(html).toContain('autoComplete="off"')
    expect(html).toContain('Cancel replacement')
    expect(html).toMatch(/type="submit" disabled=""/u)
    expect(html).not.toMatch(/Welcome|Restore/u)
  })

  it('shows only SDK activation as the first of two separate setup screens', () => {
    const html = content({ sdk: { configured: false, ready: false }, connectionConfigured: false })
    expect(html).toContain('Welcome to IBKR Tradescript Terminal')
    expect(html).toContain('Step 1 of 2')
    expect(html).toContain('Activate your SDK')
    expect(html).not.toContain('Connect your broker')
    expect(html).toContain(
      'Enter your Client key and Secret to activate the charts library on this computer.',
    )
    expect(html).toContain('aria-label="Activate SDK"')
    expect(html).not.toContain('Cancel replacement')
    expect(html).toContain('Client key')
    expect(html).toContain('Secret')
    expect(html).not.toMatch(/Licences and data information|separate licences/u)
    expect(html).not.toMatch(/Log in|Sign in|Buy license|Sync License/u)
    expect(html.match(/<a\b[^>]*>.*?<\/a>/gu)).toEqual([
      '<a href="https://console.tradescript.dev/app/deployments/localhost" target="_blank" rel="noopener noreferrer">Get credentials</a>',
    ])
  })

  it('shows broker setup on its own screen once the SDK is active', () => {
    const html = content({ ...ready, connectionConfigured: false })
    expect(html).toContain('Welcome to IBKR Tradescript Terminal')
    expect(html).toContain('Step 2 of 2')
    expect(html).toContain('Connect your broker')
    expect(html).toContain('SDK credentials saved · Activated')
    expect(html).toContain('Update SDK credentials')
    expect(html).not.toMatch(/Restore|<input|Get credentials|Client key/u)
  })

  it('keeps SDK recovery free of broker setup', () => {
    const html = content({
      sdk: { configured: true, ready: false, failure: 'rejected', failureReason: 'unauthorized' },
      connectionConfigured: false,
    })
    expect(html).toContain('Restore SDK access')
    expect(html).toContain('Client key')
    expect(html).not.toMatch(/Connect your broker|Step \d of 2/u)
  })

  it('opens replacement fields during rejected-credential recovery and preserves saved workspace', () => {
    const html = content({
      ...ready,
      sdk: { ...ready.sdk, ready: false, failure: 'rejected', failureReason: 'unauthorized' },
    })
    expect(html).toContain('Restore SDK access')
    expect(html).not.toContain('setup-authorization-notice')
    expect(html).toContain('Client key')
    expect(html).toContain('Your broker connection settings and saved workspace are preserved.')
    expect(html).not.toContain('Welcome to IBKR Tradescript Terminal')
  })

  it('keeps saved credentials during a network recovery instead of asking for replacement', () => {
    const html = content({ ...ready, sdk: { ...ready.sdk, ready: false, failure: 'unavailable' } })
    expect(html).toContain('Restore SDK access')
    expect(html).toContain('Your existing SDK credentials are saved.')
    expect(html).not.toContain('<input')
  })

  it('preserves credentials on subscription expiry without console account or purchase actions', () => {
    const html = content({
      ...ready,
      sdk: {
        ...ready.sdk,
        ready: false,
        failure: 'rejected',
        failureReason: 'subscription_access_expired',
      },
    })
    expect(html).not.toMatch(/Buy license|Log in|Sync License/u)
    expect(html).toContain('Get credentials')
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
