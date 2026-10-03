import { expect, it } from 'vitest'
import {
  sdkAccessNeedsRenewal,
  sdkAuthorizationNotice,
  sdkCredentialsNeedUpdating,
  sdkRenewalPending,
} from './sdk-authorization.js'

it('explains unpaid localhost expiry without telling users to replace preserved credentials', () => {
  for (const ready of [false, true]) {
    const notice = sdkAuthorizationNotice({
      configured: true,
      ready,
      failure: 'rejected',
      failureReason: 'trial_access_expired',
      message:
        'Your seven-day free trial access has ended. Activate a subscription in Developer Console.',
    })
    expect(notice?.title).toBe('Free trial access has ended')
    expect(notice?.message).toContain('seven-day')
    expect(notice?.message).toContain('subscription')
    expect(notice?.message).not.toContain('revoked')
    expect(notice?.message).not.toContain('Enter valid credentials')
  }
})

it.each([
  ['subscription_access_expired', 'Subscription access has ended'],
  ['subscription_inactive', 'Subscription needs attention'],
  ['sdk_version_not_authorized', 'SDK version is not authorized'],
  ['sdk_build_not_authorized', 'SDK build is not authorized'],
  ['origin_not_authorized', 'Browser origin is not authorized'],
  ['deployment_not_authorized', 'Application is not authorized'],
  ['client_suspended', 'SDK access is suspended'],
  ['authorization_changed', 'SDK authorization changed'],
  ['authorization_unavailable', 'SDK authorization temporarily unavailable'],
] as const)('carries the explicit %s reason to recovery', (failureReason, title) => {
  const notice = sdkAuthorizationNotice({
    configured: true,
    ready: false,
    failureReason,
    message: 'Detailed reason from the authorization service. Use the same saved credentials.',
  })
  expect(notice).toEqual({
    title,
    message: 'Detailed reason from the authorization service. Use the same saved credentials.',
  })
})

it('does not confuse initial authorization or a network failure with rejected credentials', () => {
  expect(sdkAuthorizationNotice({ configured: false, ready: false })).toBeUndefined()
  expect(
    sdkAuthorizationNotice({ configured: true, ready: false, state: 'exchanging' }),
  ).toBeUndefined()
  expect(sdkAuthorizationNotice({ configured: true, ready: true, state: 'ready' })).toBeUndefined()
  expect(
    sdkAuthorizationNotice({ configured: true, ready: false, failure: 'unavailable' })?.title,
  ).toBe('SDK authorization unavailable')
})

it('distinguishes rejected renewal with a valid lease from expired SDK access', () => {
  const sdk = {
    configured: true,
    ready: true,
    failure: 'rejected' as const,
    expiresAt: '2026-01-01T00:00:00.000Z',
  }
  // Server readiness is authoritative, regardless of the browser clock.
  expect(sdkAuthorizationNotice(sdk)?.title).toBe('SDK credentials need updating')
  expect(sdkAuthorizationNotice({ ...sdk, ready: false })?.title).toBe('SDK authorization expired')
  expect(
    sdkAuthorizationNotice({ ...sdk, ready: false, failure: 'unavailable' })?.message,
  ).toContain('internet connection')
})

it('treats a lease that lapsed without a failed renewal as renewing, not expired', () => {
  const lapsed = {
    configured: true,
    ready: false,
    state: 'ready' as const,
    expiresAt: '2026-01-01T00:00:00.000Z',
  }
  expect(sdkRenewalPending(lapsed)).toBe(true)
  expect(sdkAuthorizationNotice(lapsed)).toBeUndefined()
  expect(sdkRenewalPending({ ...lapsed, state: 'exchanging' })).toBe(true)
  expect(sdkRenewalPending({ ...lapsed, failure: 'unavailable' })).toBe(false)
  expect(sdkAuthorizationNotice({ ...lapsed, failure: 'unavailable' })?.title).toBe(
    'SDK authorization expired',
  )
  // Without a previous lease, initial authorization still gates setup.
  expect(sdkRenewalPending({ configured: true, ready: false, state: 'exchanging' })).toBe(false)
})

it('offers credential replacement only for authentication failures', () => {
  const sdk = { configured: true, ready: false, failure: 'rejected' as const }
  expect(sdkCredentialsNeedUpdating({ ...sdk, failureReason: 'unauthorized' })).toBe(true)
  for (const failureReason of [
    'trial_access_expired',
    'subscription_access_expired',
    'sdk_build_not_authorized',
    'origin_not_authorized',
    'internal_error',
    'authorization_changed',
  ] as const) {
    expect(sdkCredentialsNeedUpdating({ ...sdk, failureReason })).toBe(false)
  }
  expect(sdkAccessNeedsRenewal({ ...sdk, failureReason: 'subscription_access_expired' })).toBe(true)
})
