import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialStore } from '../src/tradescript/credential-store.js'
import { Licensing } from '../src/tradescript/licensing.js'

const directories: string[] = []
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-credentials-'))
  directories.push(dir)
  return dir
}
afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const credentials = { credentialId: 'fixture-id', credentialSecret: 'fixture-secret' }

describe('local SDK credentials', () => {
  it('logs out locally, clears the current lease and credentials, and stays logged out after restart even when environment credentials exist', async () => {
    const store = new CredentialStore(join(directory(), 'credentials.json'), randomBytes(32))
    store.write(credentials)
    const config = {
      packageName: 'fixture',
      runtimeCredentialsConfigured: true,
      ...credentials,
      sdkVersion: '0.1.34',
      customerBuildFingerprint: 'fixture',
      credentialExchangeUrl: 'https://example.test/lease',
      requestedOrigin: 'http://127.0.0.1:43871',
    }
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({
        lease: 'x'.repeat(64),
        leaseType: 'TradeScript-Deployment-Lease',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        expiresIn: 60,
        renewAfter: new Date(Date.now() + 30000).toISOString(),
        renewAfterIn: 30,
        catalogVersion: 'fixture',
        policy: {},
      }),
    )
    vi.stubGlobal('fetch', transport)
    const licensing = new Licensing(config, store)
    await licensing.getLease()
    expect(licensing.snapshot().ready).toBe(true)
    licensing.logout()
    expect(store.read()).toBeUndefined()
    expect(store.isSignedOut()).toBe(true)
    expect(licensing.config).not.toHaveProperty('credentialSecret')
    expect(licensing.snapshot()).toMatchObject({ state: 'unconfigured', ready: false })
    await expect(licensing.getLease()).rejects.toThrow('not configured')
    const restarted = new Licensing(config, store)
    expect(restarted.config.runtimeCredentialsConfigured).toBe(false)
    expect(restarted.snapshot().ready).toBe(false)
    expect(transport).toHaveBeenCalledOnce()
    await restarted.activate(credentials)
    expect(store.isSignedOut()).toBe(false)
    expect(restarted.snapshot().ready).toBe(true)
    licensing.stop()
    restarted.stop()
  })
  it('keeps recovery available when saved credentials cannot decrypt, then replaces them only after valid activation', async () => {
    const path = join(directory(), 'credentials.json')
    new CredentialStore(path, randomBytes(32)).write(credentials)
    const store = new CredentialStore(path, randomBytes(32))
    const now = Date.now()
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
    vi.stubGlobal('fetch', fetchMock)
    const licensing = new Licensing(
      {
        packageName: 'fixture',
        runtimeCredentialsConfigured: true,
        credentialId: 'env-fixture',
        credentialSecret: 'env-fixture-secret',
        sdkVersion: '0.1.34',
        customerBuildFingerprint: 'fixture',
        credentialExchangeUrl: 'https://example.test/lease',
        requestedOrigin: 'http://localhost:3000',
      },
      store,
    )
    try {
      licensing.start()
      expect(licensing.snapshot()).toMatchObject({
        ready: false,
        state: 'error',
        message: expect.stringContaining('Reactivate'),
      })
      expect(licensing.config.runtimeCredentialsConfigured).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(() => store.read()).toThrow('could not be read')
      await licensing.activate(credentials)
      expect(licensing.snapshot().ready).toBe(true)
      expect(store.read()).toEqual(credentials)
    } finally {
      licensing.stop()
    }
  })
  it('returns the access-expiry guidance on retry and activation without replacing credentials', async () => {
    const store = new CredentialStore(join(directory(), 'credentials.json'))
    store.write(credentials)
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            error: {
              code: 'trial_access_expired',
              message:
                'Your seven-day free trial access has ended. Activate a subscription in Developer Console.',
            },
          },
          { status: 403 },
        ),
      ),
    )
    const licensing = new Licensing(
      {
        packageName: 'fixture',
        runtimeCredentialsConfigured: false,
        sdkVersion: '0.1.34',
        customerBuildFingerprint: 'fixture',
        credentialExchangeUrl: 'https://example.test/lease',
        requestedOrigin: 'http://localhost:3000',
      },
      store,
    )
    try {
      await expect(licensing.retry()).rejects.toThrow('seven-day free trial access has ended')
      await expect(licensing.activate(credentials)).rejects.toThrow(
        'seven-day free trial access has ended',
      )
      expect(licensing.snapshot()).toMatchObject({
        failureReason: 'trial_access_expired',
        ready: false,
      })
      expect(store.read()).toEqual(credentials)
    } finally {
      licensing.stop()
    }
  })
  it('encrypts desktop credentials and rejects tampered or wrong-key files', () => {
    const path = join(directory(), 'credentials.json')
    const key = randomBytes(32)
    const store = new CredentialStore(path, key)
    expect(store.read()).toBeUndefined()
    store.write(credentials)
    expect(readFileSync(path, 'utf8')).not.toContain(credentials.credentialSecret)
    expect(new CredentialStore(path, key).read()).toEqual(credentials)
    expect(() => new CredentialStore(path, randomBytes(32)).read()).toThrow('could not be read')
    const envelope = JSON.parse(readFileSync(path, 'utf8'))
    envelope.data = Buffer.from('tampered').toString('base64')
    writeFileSync(path, JSON.stringify(envelope))
    expect(() => store.read()).toThrow('could not be read')
  })
  it('supports source installs without desktop keychain dependencies', () => {
    const store = new CredentialStore(join(directory(), 'credentials.json'))
    store.write(credentials)
    expect(store.read()).toEqual(credentials)
  })
  it('validates activation before replacing the saved credentials', async () => {
    const store = new CredentialStore(join(directory(), 'credentials.json'), randomBytes(32))
    const licensing = new Licensing(
      {
        packageName: 'fixture',
        runtimeCredentialsConfigured: false,
        sdkVersion: '0.1.32',
        customerBuildFingerprint: 'fixture',
        credentialExchangeUrl: 'https://example.test/lease',
        requestedOrigin: 'http://127.0.0.1:43871',
      },
      store,
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
    // Construct again after replacing fetch, which is captured by each lease manager.
    await expect(licensing.activate(credentials)).rejects.toThrow('status 401')
    expect(store.read()).toBeUndefined()
    const now = Date.now()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
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
      ),
    )
    await licensing.activate(credentials)
    expect(store.read()).toEqual(credentials)
    expect(licensing.snapshot().ready).toBe(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
    await expect(licensing.activate({ ...credentials, credentialSecret: 'bad' })).rejects.toThrow(
      'status 403',
    )
    expect(store.read()).toEqual(credentials)
    expect(licensing.snapshot().ready).toBe(true)
    licensing.stop()
  })

  it('recovers saved rejected credentials by retrying or replacing them without overwriting on failure', async () => {
    const store = new CredentialStore(join(directory(), 'credentials.json'), randomBytes(32))
    store.write(credentials)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const licensing = new Licensing(
      {
        packageName: 'fixture',
        runtimeCredentialsConfigured: false,
        sdkVersion: '0.1.34',
        customerBuildFingerprint: 'fixture',
        credentialExchangeUrl: 'https://example.test/lease',
        requestedOrigin: 'http://127.0.0.1:43871',
      },
      store,
    )
    const valid = async () => {
      const now = Date.now()
      return Response.json({
        lease: 'x'.repeat(64),
        leaseType: 'TradeScript-Deployment-Lease',
        expiresAt: new Date(now + 60000).toISOString(),
        expiresIn: 60,
        renewAfter: new Date(now + 30000).toISOString(),
        renewAfterIn: 30,
        catalogVersion: 'fixture',
        policy: {},
      })
    }
    try {
      await expect(licensing.getLease()).rejects.toThrow('status 401')
      expect(licensing.snapshot()).toMatchObject({ ready: false, failure: 'rejected' })
      await expect(licensing.retry()).rejects.toThrow('status 401')
      await expect(licensing.activate({ ...credentials, credentialSecret: 'bad' })).rejects.toThrow(
        'status 401',
      )
      expect(store.read()).toEqual(credentials)
      fetchMock.mockImplementation(valid)
      await licensing.retry()
      expect(licensing.snapshot().ready).toBe(true)
      expect(store.read()).toEqual(credentials)
      fetchMock.mockImplementation(async () => new Response('{}', { status: 403 }))
      await expect(licensing.retry()).rejects.toThrow('status 403')
      fetchMock.mockImplementation(valid)
      const replacement = { credentialId: 'replacement', credentialSecret: 'replacement-secret' }
      await licensing.activate(replacement)
      expect(store.read()).toEqual(replacement)
      expect(licensing.snapshot()).toMatchObject({ ready: true, state: 'ready' })
      expect(licensing.snapshot()).not.toHaveProperty('failure')
      expect(fetchMock.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
        authorization: `Basic ${Buffer.from(`${replacement.credentialId}:${replacement.credentialSecret}`).toString('base64')}`,
      })
    } finally {
      licensing.stop()
    }
  })
})
