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
    expect(manager.snapshot()).toMatchObject({ state: 'error', ready: false, failure: 'rejected' })
    manager.stop()
  })

  it.each([
    [403, 'trial_access_expired', 'seven-day free trial access'],
    [403, 'subscription_access_expired', 'Subscription coverage ended. Restore access.'],
    [403, 'subscription_inactive', 'Subscription is inactive. Resolve billing.'],
    [403, 'client_suspended', 'Client is suspended. Contact administrator.'],
    [403, 'sdk_version_not_authorized', 'Install an authorized SDK version.'],
    [403, 'sdk_build_not_authorized', 'Install the authorized SDK build.'],
    [403, 'origin_not_authorized', 'Use an authorized browser origin.'],
    [403, 'deployment_not_authorized', 'Register the application identity.'],
    [401, 'unauthorized', 'Runtime identity was rejected. Configure a valid identity.'],
    [400, 'invalid_request', 'Correct the lease request.'],
    [413, 'invalid_request', 'The request body is too large.'],
    [415, 'invalid_request', 'Send application/json.'],
    [404, 'not_found', 'Check the authorization endpoint URL.'],
    [405, 'method_not_allowed', 'Send a POST request to the lease endpoint.'],
  ] as const)(
    'preserves the authenticated expiry reason from status %i',
    async (status, code, message) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json({ error: { code, message } }, { status }),
      )
      const manager = new TradeScriptLeaseManager(configured(), { fetch: fetchMock })
      try {
        await expect(manager.getLease()).rejects.toThrow(message)
        expect(manager.snapshot()).toMatchObject({
          state: 'error',
          ready: false,
          failure: 'rejected',
          failureReason: code,
        })
        expect(manager.snapshot().message).toBe(message)
      } finally {
        manager.stop()
      }
    },
  )

  it.each([
    [409, 'authorization_changed'],
    [503, 'authorization_unavailable'],
    [500, 'internal_error'],
  ] as const)('retries status %i without changing the identity', async (status, code) => {
    const manager = new TradeScriptLeaseManager(configured(), {
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json(
          { error: { code, message: 'Retry with the same saved identity.' } },
          { status },
        ),
      ),
    })
    try {
      await expect(manager.getLease()).rejects.toMatchObject({
        retryable: true,
        rejected: false,
        statusCode: status,
      })
      expect(manager.snapshot()).toMatchObject({
        failure: 'unavailable',
        failureReason: code,
        message: 'Retry with the same saved identity.',
      })
    } finally {
      manager.stop()
    }
  })

  it('does not infer an expiry reason from an unknown or mismatched error response', async () => {
    const manager = new TradeScriptLeaseManager(configured(), {
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            error: {
              code: 'trial_access_expired',
              message: 'Your seven-day free trial access has ended. Activate a subscription.',
            },
          },
          { status: 401 },
        ),
      ),
    })
    try {
      await expect(manager.getLease()).rejects.toThrow('status 401')
      expect(manager.snapshot()).not.toHaveProperty('failureReason')
    } finally {
      manager.stop()
    }
  })

  it('clears an expiry reason after a successful retry with the same credentials', async () => {
    const now = Date.now()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        Response.json(
          {
            error: {
              code: 'trial_access_expired',
              message: 'Your seven-day free trial access has ended. Activate a subscription.',
            },
          },
          { status: 403 },
        ),
      )
      .mockImplementation(async () =>
        Response.json({
          lease: 'x'.repeat(64),
          leaseType: 'TradeScript-Deployment-Lease',
          expiresAt: new Date(now + 60000).toISOString(),
          expiresIn: 60,
          renewAfter: new Date(now + 30000).toISOString(),
          renewAfterIn: 30,
          catalogVersion: 'fixture',
          policy: {},
        }),
      )
    const manager = new TradeScriptLeaseManager(configured(), { fetch: fetchMock })
    try {
      await expect(manager.getLease()).rejects.toThrow('seven-day')
      await manager.refresh()
      expect(manager.snapshot()).toMatchObject({ state: 'ready', ready: true })
      expect(manager.snapshot()).not.toHaveProperty('failureReason')
      expect(manager.snapshot()).not.toHaveProperty('failure')
    } finally {
      manager.stop()
    }
  })

  it.each([401, 403, 503])(
    'preserves the current lease until expiry after renewal returns %i, and recovers',
    async (status) => {
      let now = Date.now()
      const valid = () =>
        Response.json({
          lease: 'x'.repeat(64),
          leaseType: 'TradeScript-Deployment-Lease',
          expiresAt: new Date(now + 60000).toISOString(),
          expiresIn: 60,
          renewAfter: new Date(now + 30000).toISOString(),
          renewAfterIn: 30,
          catalogVersion: 'fixture',
          policy: {},
        })
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => valid())
        .mockImplementationOnce(async () => new Response('{}', { status }))
        .mockImplementation(async () => valid())
      const manager = new TradeScriptLeaseManager(configured(), {
        fetch: fetchMock,
        now: () => now,
      })
      try {
        await manager.getLease()
        await expect(manager.refresh()).rejects.toThrow(`status ${status}`)
        expect(manager.snapshot()).toMatchObject({
          ready: true,
          state: 'degraded',
          failure: status === 503 ? 'unavailable' : 'rejected',
        })
        now += 60001
        expect(manager.snapshot().ready).toBe(false)
        await manager.refresh()
        expect(manager.snapshot()).toMatchObject({ ready: true, state: 'ready' })
        expect(manager.snapshot()).not.toHaveProperty('failure')
      } finally {
        manager.stop()
      }
    },
  )

  it('renews an overdue lease when its timer was missed, but not after a failed renewal', async () => {
    let now = Date.now()
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        lease: 'x'.repeat(64),
        leaseType: 'TradeScript-Deployment-Lease',
        expiresAt: new Date(now + 60000).toISOString(),
        expiresIn: 60,
        renewAfter: new Date(now + 30000).toISOString(),
        renewAfterIn: 30,
        catalogVersion: 'fixture',
        policy: {},
      }),
    )
    const manager = new TradeScriptLeaseManager(configured(), { fetch: fetchMock, now: () => now })
    try {
      await manager.getLease()
      manager.renewIfDue()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // The computer slept past expiry before the renewal timer fired.
      now += 60001
      expect(manager.snapshot()).toMatchObject({ ready: false, state: 'ready' })
      expect(manager.snapshot()).not.toHaveProperty('failure')
      manager.renewIfDue()
      manager.renewIfDue()
      expect(manager.snapshot()).toMatchObject({ ready: false, state: 'exchanging' })
      await vi.waitFor(() =>
        expect(manager.snapshot()).toMatchObject({ ready: true, state: 'ready' }),
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)
      fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }))
      now += 60001
      await expect(manager.refresh()).rejects.toThrow('status 401')
      manager.renewIfDue()
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      manager.stop()
    }
  })
})
