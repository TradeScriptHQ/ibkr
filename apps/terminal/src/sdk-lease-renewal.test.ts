import type { TradeScriptBootstrapResponse } from '@ibkr-terminal/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { followSdkLease } from './sdk-lease-renewal.js'

const now = Date.parse('2026-09-30T12:00:00Z')
function lease(token = 'a', expires = 60_000, renew = 100): TradeScriptBootstrapResponse {
  return {
    lease: token.repeat(64),
    leaseType: 'TradeScript-Deployment-Lease',
    sdkVersion: '0.1.34',
    customerBuildFingerprint: `tsfp1_${'a'.repeat(32)}`,
    expiresAt: new Date(now + expires).toISOString(),
    renewAfter: new Date(now + renew).toISOString(),
    paperTrading: { enabled: false, autonomyMode: 'paper-auto', allowedAccountIds: [] },
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const sdk = { replaceLease: vi.fn().mockResolvedValue(undefined) }
  const failed = vi.fn()
  const abort = new AbortController()
  return { fetch, sdk, failed, abort }
}
it('replaces a renewed token on the same SDK and leaves an unchanged token alone', async () => {
  const { fetch, sdk, failed, abort } = fixture()
  fetch.mockResolvedValue(new Response(JSON.stringify(lease('b', 120_000, 40_000))))
  const stop = followSdkLease(sdk, lease(), abort.signal, failed)
  await vi.advanceTimersByTimeAsync(100)
  expect(sdk.replaceLease).toHaveBeenCalledExactlyOnceWith('b'.repeat(64))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(sdk.replaceLease).toHaveBeenCalledOnce()
  expect(failed).not.toHaveBeenCalled()
  stop()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('keeps the valid SDK authority during a transient failure and recovers', async () => {
  const { fetch, sdk, failed, abort } = fixture()
  fetch
    .mockResolvedValueOnce(new Response('', { status: 502 }))
    .mockResolvedValue(new Response(JSON.stringify(lease('b', 120_000, 40_000))))
  const stop = followSdkLease(sdk, lease(), abort.signal, failed)
  await vi.advanceTimersByTimeAsync(100)
  expect(failed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(sdk.replaceLease).toHaveBeenCalledOnce()
  stop()
})
it('surfaces an unavailable renewal once the current lease actually expires', async () => {
  const { fetch, failed, sdk, abort } = fixture()
  fetch.mockResolvedValue(new Response('', { status: 503 }))
  followSdkLease(sdk, lease('a', 1_000), abort.signal, failed)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(failed).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(failed).toHaveBeenCalledOnce()
})
it('stops immediately on denied authorization or an SDK replacement rejection', async () => {
  const { fetch, failed, sdk, abort } = fixture()
  fetch.mockResolvedValue(new Response('', { status: 403 }))
  followSdkLease(sdk, lease(), abort.signal, failed)
  await vi.advanceTimersByTimeAsync(100)
  expect(failed).toHaveBeenCalledOnce()
  expect(sdk.replaceLease).not.toHaveBeenCalled()
  fetch.mockResolvedValue(new Response(JSON.stringify(lease('b'))))
  sdk.replaceLease.mockRejectedValue(new Error('authorization verification failed'))
  const rejected = vi.fn()
  followSdkLease(sdk, lease(), abort.signal, rejected)
  await vi.advanceTimersByTimeAsync(100)
  expect(rejected).toHaveBeenCalledOnce()
})
it('does not install a late response after workstation disposal', async () => {
  const { fetch, failed, sdk, abort } = fixture()
  const pending = Promise.withResolvers<Response>()
  fetch.mockReturnValue(pending.promise)
  followSdkLease(sdk, lease(), abort.signal, failed)
  await vi.advanceTimersByTimeAsync(100)
  abort.abort()
  pending.resolve(new Response(JSON.stringify(lease('b'))))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(sdk.replaceLease).not.toHaveBeenCalled()
  expect(failed).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledOnce()
})

it.each(['fetch', 'replacement'] as const)(
  'expires visibly even if the %s promise never settles',
  async (pendingStep) => {
    const { fetch, failed, sdk, abort } = fixture()
    const pending = Promise.withResolvers<Response>()
    if (pendingStep === 'fetch') fetch.mockReturnValue(pending.promise)
    else {
      fetch.mockResolvedValue(new Response(JSON.stringify(lease('b', 120_000, 40_000))))
      sdk.replaceLease.mockReturnValue(new Promise(() => undefined))
    }
    followSdkLease(sdk, lease('a', 1_000), abort.signal, failed)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(failed).toHaveBeenCalledOnce()
    pending.resolve(new Response(JSON.stringify(lease('b'))))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(failed).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  },
)
