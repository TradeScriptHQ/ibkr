import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { TradeScriptLeaseManager } from '../src/tradescript/lease-manager.js'

function configured() {
  return loadGatewayConfig({
    TRADESCRIPT_CREDENTIAL_ID: 'credential',
    TRADESCRIPT_CREDENTIAL_SECRET: 'one-time-secret',
    TRADESCRIPT_CREDENTIAL_EXCHANGE_URL:
      'https://chart-authorization.tradescript.dev/v1/deployment-leases',
    TRADESCRIPT_SDK_VERSION: '0.1.1',
    TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT: 'tsfp1_0123456789abcdef0123456789abcdef',
  }).tradescript
}

describe('TradeScript deployment lease manager', () => {
  it('keeps the permanent credential backend-only and caches the signed lease', async () => {
    const now = Date.parse('2026-08-27T12:00:00.000Z')
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        authorization: expect.stringMatching(/^Basic /u),
        'content-type': 'application/json',
      })
      expect(JSON.parse(String(init?.body))).toEqual({
        sdkVersion: '0.1.1',
        customerBuildFingerprint: 'tsfp1_0123456789abcdef0123456789abcdef',
        requestedOrigin: 'http://localhost:3000',
      })
      return new Response(
        JSON.stringify({
          lease: 'signed-deployment-lease-token-that-is-long-enough-for-contract-validation-0001',
          leaseType: 'TradeScript-Deployment-Lease',
          expiresAt: '2026-09-03T12:00:00.000Z',
          expiresIn: 604800,
          renewAfter: '2026-08-28T00:00:00.000Z',
          renewAfterIn: 43200,
          catalogVersion: '2026-08-27',
          policy: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const manager = new TradeScriptLeaseManager(configured(), {
      fetch: fetchMock,
      now: () => now,
    })
    const first = await manager.getLease()
    const second = await manager.getLease()
    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(manager.snapshot()).toMatchObject({ state: 'ready', ready: true })
    manager.stop()
  })

  it('fails closed when authorization rejects the credential', async () => {
    const manager = new TradeScriptLeaseManager(configured(), {
      fetch: vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 })),
    })
    await expect(manager.getLease()).rejects.toThrow(/status 401/u)
    expect(manager.snapshot()).toMatchObject({ state: 'error', ready: false })
    manager.stop()
  })
})
