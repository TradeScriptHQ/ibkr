import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})
const response = (token: string) =>
  Response.json({
    csrfToken: token.repeat(43),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })

it('shares an in-flight bootstrap and refreshes a settled session for a new startup attempt', async () => {
  const first = Promise.withResolvers<Response>()
  const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(response('b'))
  vi.stubGlobal('fetch', fetch)
  const { bootstrapBrowserSession } = await import('./terminal-session.js')
  const one = bootstrapBrowserSession(true)
  const two = bootstrapBrowserSession(true)
  expect(two).toBe(one)
  expect(fetch).toHaveBeenCalledOnce()
  first.resolve(response('a'))
  await one
  expect(await bootstrapBrowserSession()).toMatchObject({ csrfToken: 'a'.repeat(43) })
  expect(await bootstrapBrowserSession(true)).toMatchObject({ csrfToken: 'b'.repeat(43) })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('retries a failed bootstrap instead of caching the rejection', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 502 }))
    .mockResolvedValue(response('b'))
  vi.stubGlobal('fetch', fetch)
  const { bootstrapBrowserSession } = await import('./terminal-session.js')
  await expect(bootstrapBrowserSession()).rejects.toThrow('secure local session')
  expect(await bootstrapBrowserSession()).toMatchObject({ csrfToken: 'b'.repeat(43) })
})

it('notifies mounted consumers once only when renewed session authority changes', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response('a'))
    .mockResolvedValueOnce(response('a'))
    .mockResolvedValueOnce(response('b'))
    .mockResolvedValueOnce(response('c'))
  vi.stubGlobal('fetch', fetch)
  const { bootstrapBrowserSession, subscribeBrowserSessionChanges } = await import(
    './terminal-session.js'
  )
  const changed = vi.fn()
  const stop = subscribeBrowserSessionChanges(changed)
  await bootstrapBrowserSession()
  await bootstrapBrowserSession(true)
  expect(changed).not.toHaveBeenCalled()
  await bootstrapBrowserSession(true)
  expect(changed).toHaveBeenCalledOnce()
  stop()
  await bootstrapBrowserSession(true)
  expect(changed).toHaveBeenCalledOnce()
})

it('shares concurrent recovery and does not notify for failed or malformed renewal', async () => {
  const pending = Promise.withResolvers<Response>()
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response('a'))
    .mockResolvedValueOnce(new Response('', { status: 502 }))
    .mockResolvedValueOnce(Response.json({ csrfToken: 'invalid' }))
    .mockReturnValueOnce(pending.promise)
  vi.stubGlobal('fetch', fetch)
  const { bootstrapBrowserSession, subscribeBrowserSessionChanges } = await import(
    './terminal-session.js'
  )
  await bootstrapBrowserSession()
  const changed = vi.fn()
  subscribeBrowserSessionChanges(changed)
  await expect(bootstrapBrowserSession(true)).rejects.toThrow()
  await expect(bootstrapBrowserSession(true)).rejects.toThrow()
  expect(changed).not.toHaveBeenCalled()
  const one = bootstrapBrowserSession(true)
  const two = bootstrapBrowserSession(true)
  expect(two).toBe(one)
  pending.resolve(response('b'))
  await one
  expect(changed).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledTimes(4)
})

it('revalidates an expired cached session and notifies consumers of its replacement', async () => {
  vi.useFakeTimers()
  try {
    const fetch = vi.fn().mockResolvedValueOnce(response('a')).mockResolvedValueOnce(response('b'))
    vi.stubGlobal('fetch', fetch)
    const { bootstrapBrowserSession, subscribeBrowserSessionChanges } = await import(
      './terminal-session.js'
    )
    const changed = vi.fn()
    subscribeBrowserSessionChanges(changed)
    await bootstrapBrowserSession()
    vi.advanceTimersByTime(60_001)
    await bootstrapBrowserSession()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})
