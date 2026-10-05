import { ConnectionSnapshotSchema } from '@ibkr-terminal/contracts'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const profile = {
  connectionType: 'ib-gateway',
  port: 4002,
  clientId: 35299,
  allowedAccountIds: [],
  agentTradingEnabled: false,
}
const connection = ConnectionSnapshotSchema.parse({
  generation: 'current-generation',
  settings: { active: 'paper', profiles: { paper: profile, live: profile } },
})
const bootstrap = () =>
  Response.json({
    csrfToken: 'a'.repeat(43),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })

it('authenticates a retry of the current generation without replacing its settings or client ID', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(bootstrap())
    .mockResolvedValueOnce(Response.json(connection))
    .mockResolvedValueOnce(Response.json(connection))
  vi.stubGlobal('fetch', fetch)
  const { retryConnection } = await import('./connection-client.js')
  expect(await retryConnection()).toEqual(connection)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(fetch).toHaveBeenLastCalledWith('/api/v1/connection/retry', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'x-tradescript-client': 'terminal-v1',
      'x-tradescript-connection': connection.generation,
      'Content-Type': 'application/json',
      'x-tradescript-csrf': 'a'.repeat(43),
    },
    body: JSON.stringify({ generation: connection.generation }),
  })
})

it('surfaces a changed connection generation without silently replaying the retry', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(bootstrap())
    .mockResolvedValueOnce(Response.json(connection))
    .mockResolvedValueOnce(
      Response.json({ error: { message: 'The connection changed.' } }, { status: 409 }),
    )
  vi.stubGlobal('fetch', fetch)
  const { retryConnection } = await import('./connection-client.js')
  await expect(retryConnection()).rejects.toMatchObject({
    status: 409,
    message: 'The connection changed.',
  })
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('does not send a retry when the current connection cannot be read', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(bootstrap())
    .mockResolvedValueOnce(new Response('', { status: 503 }))
  vi.stubGlobal('fetch', fetch)
  const { retryConnection } = await import('./connection-client.js')
  await expect(retryConnection()).rejects.toThrow('Connection settings are unavailable.')
  expect(fetch).toHaveBeenCalledTimes(2)
})
