import { afterEach, expect, it, vi } from 'vitest'
import { loadApplicationSetupStatus } from './application-setup-status.js'

const bootstrap = vi.hoisted(() => vi.fn())
vi.mock('./terminal-session.js', () => ({
  bootstrapBrowserSession: bootstrap,
  CLIENT_HEADERS: { 'x-tradescript-client': 'terminal-v1' },
}))
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
const ready = { sdk: { configured: true, ready: true }, connectionConfigured: true }
const expired = () =>
  Response.json({ error: { code: 'invalid-session', message: 'Expired' } }, { status: 401 })

it('uses the current session for an ordinary setup read without renewal', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(ready))
  vi.stubGlobal('fetch', fetch)
  const invalid = vi.fn()
  expect(await loadApplicationSetupStatus(invalid)).toEqual(ready)
  expect(bootstrap.mock.calls).toEqual([[]])
  expect(invalid).not.toHaveBeenCalled()
})

it('renews confirmed expired local authority and retries only the safe setup GET once', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(expired()).mockResolvedValueOnce(Response.json(ready))
  vi.stubGlobal('fetch', fetch)
  const invalid = vi.fn()
  expect(await loadApplicationSetupStatus(invalid)).toEqual(ready)
  expect(invalid).toHaveBeenCalledOnce()
  expect(bootstrap.mock.calls).toEqual([[], [true]])
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const [path, options] of fetch.mock.calls) {
    expect(path).toBe('/api/v1/setup')
    expect(options).not.toHaveProperty('body')
    expect(options.method ?? 'GET').toBe('GET')
  }
})

it('bounds a repeatedly rejected session instead of looping or replaying requests', async () => {
  const fetch = vi.fn().mockImplementation(async () => expired())
  vi.stubGlobal('fetch', fetch)
  await expect(loadApplicationSetupStatus(vi.fn())).rejects.toThrow('local session')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(bootstrap.mock.calls).toEqual([[], [true]])
})

it('does not treat license rejection or an unknown 401 as a local session reset', async () => {
  for (const response of [
    Response.json({ error: { code: 'unauthorized', message: 'SDK rejected' } }, { status: 401 }),
    new Response('<html>Unauthorized</html>', { status: 401 }),
  ]) {
    bootstrap.mockClear()
    const fetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch)
    const invalid = vi.fn()
    await expect(loadApplicationSetupStatus(invalid)).rejects.toThrow('application setup')
    expect(invalid).not.toHaveBeenCalled()
    expect(bootstrap.mock.calls).toEqual([[]])
    expect(fetch).toHaveBeenCalledOnce()
  }
})

it('leaves a failed renewal retryable on the next poll', async () => {
  bootstrap.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Gateway restarting'))
  const fetch = vi.fn().mockResolvedValueOnce(expired()).mockResolvedValueOnce(Response.json(ready))
  vi.stubGlobal('fetch', fetch)
  const invalid = vi.fn()
  await expect(loadApplicationSetupStatus(invalid)).rejects.toThrow('Gateway restarting')
  expect(await loadApplicationSetupStatus(invalid)).toEqual(ready)
  expect(invalid).toHaveBeenCalledOnce()
})

it('does not renew for a superseded polling attempt', async () => {
  const fetch = vi.fn().mockResolvedValue(expired())
  vi.stubGlobal('fetch', fetch)
  await expect(
    loadApplicationSetupStatus(() => {
      throw new DOMException('Superseded', 'AbortError')
    }),
  ).rejects.toThrow('Superseded')
  expect(bootstrap.mock.calls).toEqual([[]])
  expect(fetch).toHaveBeenCalledOnce()
})
