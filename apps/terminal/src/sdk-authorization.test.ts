import { expect, it } from 'vitest'
import { sdkAuthorizationNotice, sdkRenewalPending } from './sdk-authorization.js'

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
