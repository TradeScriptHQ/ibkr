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
    await expect(licensing.activate(credentials)).rejects.toThrow('activation failed')
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
      'activation failed',
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
      await expect(licensing.retry()).rejects.toThrow('still unavailable')
      await expect(licensing.activate({ ...credentials, credentialSecret: 'bad' })).rejects.toThrow(
        'activation failed',
      )
      expect(store.read()).toEqual(credentials)
      fetchMock.mockImplementation(valid)
      await licensing.retry()
      expect(licensing.snapshot().ready).toBe(true)
      expect(store.read()).toEqual(credentials)
      fetchMock.mockImplementation(async () => new Response('{}', { status: 403 }))
      await expect(licensing.retry()).rejects.toThrow('still unavailable')
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
