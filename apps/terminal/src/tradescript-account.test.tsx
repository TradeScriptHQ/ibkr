import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { SetupStatus } from './sdk-authorization.js'
import {
  appOpeningAccountId,
  TradeScriptAccountControls,
  terminalLicenseLabel,
} from './tradescript-account.js'

const id = '8dc43b3e-8c46-4c0a-a51e-cfe383a45762'
const noop = () => undefined
function render(account: SetupStatus['account'], configured = false) {
  return renderToStaticMarkup(
    <TradeScriptAccountControls
      account={account}
      configured={configured}
      busy={false}
      onLogin={noop}
      onSync={noop}
      onBuy={noop}
      onLogout={noop}
    />,
  )
}

it('shows Google account login and manual setup guidance on first use', () => {
  const html = render({ state: 'signed-out' })
  expect(html).toContain('Log in to TradeScript')
  expect(html).toContain('Buy license')
  expect(html).toContain('enter your license credentials below')
  expect(html).not.toContain('Sync License')
  expect(html).not.toContain('npm')
})

it('offers logout for existing manual credentials and cancel for an ongoing login', () => {
  expect(render({ state: 'signed-out' }, true)).toContain('Log out')
  const html = render({ state: 'authenticating', message: 'Finish signing in in your browser.' })
  expect(html).toContain('Cancel sign-in')
  expect(html).not.toContain('Log in to TradeScript')
})

it('shows original trial timing and suppresses trial and duplicate buy messaging for paid access', () => {
  const account: SetupStatus['account'] = {
    state: 'signed-in',
    account: { id, email: 'trader@example.test' },
    license: {
      status: 'active',
      kind: 'trial',
      trialDays: 7,
      trialEndsAt: '2026-10-09T00:00:00Z',
      credentialsAvailable: true,
    },
  }
  expect(terminalLicenseLabel(account, Date.parse('2026-10-02T00:00:00Z'))).toBe(
    'Free trial · 7 of 7 days remaining',
  )
  expect(terminalLicenseLabel(account, Date.parse('2026-10-08T12:00:00Z'))).toBe(
    'Free trial · 1 of 7 days remaining',
  )
  expect(terminalLicenseLabel(account, Date.parse('2026-10-09T00:00:00Z'))).toBe(
    'Free trial · Expired',
  )
  const paid = render({
    ...account,
    license: {
      status: 'active',
      kind: 'paid',
      plan: 'individual',
      credentialsAvailable: true,
      trialDays: 7,
    },
  })
  expect(paid).toContain('TradeScript Charts Individual · Active')
  expect(paid).toContain('Sync License')
  expect(paid).toContain('Log out')
  expect(paid).not.toMatch(/Free trial|Buy license/u)
})

it('highlights buying an expired trial while preserving account sync and logout', () => {
  const html = render(
    {
      state: 'signed-in',
      license: { status: 'expired', kind: 'trial', credentialsAvailable: true, trialDays: 7 },
    },
    true,
  )
  expect(html).toContain('Free trial · Expired')
  expect(html).toMatch(/class="setup-primary"[^>]*>Buy license/u)
  expect(html).toContain('Sync License')
  expect(html).toContain('Log out')
})

it('accepts only a bounded account-constrained sync signal with no secrets or executable URL payloads', () => {
  expect(appOpeningAccountId(`tradescript-terminal://sync-license?accountId=${id}`)).toBe(id)
  for (const value of [
    `https://sync-license?accountId=${id}`,
    `tradescript-terminal://sync-license/other?accountId=${id}`,
    `tradescript-terminal://other?accountId=${id}`,
    `tradescript-terminal://sync-license?accountId=${id}&secret=fixture`,
    `tradescript-terminal://sync-license?accountId=${id}#fragment`,
    'tradescript-terminal://sync-license?accountId=invalid',
    'javascript:alert(1)',
  ])
    expect(appOpeningAccountId(value)).toBeUndefined()
})

it('presents existing account two-step verification instead of restarting OAuth or offering duplicate purchases', () => {
  const html = renderToStaticMarkup(
    <TradeScriptAccountControls
      account={{ state: 'mfa-required', message: 'Complete two-step verification.' }}
      configured={false}
      busy={false}
      onLogin={noop}
      onSync={noop}
      onBuy={noop}
      onLogout={noop}
      onVerifyMfa={noop}
    />,
  )
  expect(html).toContain('Authenticator code')
  expect(html).toContain('Verify and continue')
  expect(html).toContain('one-time-code')
  expect(html).toContain('Log out')
  expect(html).not.toContain('Log in to TradeScript')
  expect(html).not.toContain('Buy license')
})
