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
})
