import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter'

afterEach(() => vi.unstubAllGlobals())

it('keeps the CSRF token scoped to the broker adapter that owns it', async () => {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          connectionStatus: 'connected',
          accounts: [],
          positions: [],
          executions: [],
          messages: [],
          orders: [],
        }),
      ),
  )
  vi.stubGlobal('fetch', fetchMock)

  const first = createIbkrHttpBrokerAdapter({
    executionEnvironment: 'live',
    csrfToken: 'first-session-token',
  })
  createIbkrHttpBrokerAdapter({
    executionEnvironment: 'live',
    csrfToken: 'second-session-token',
  })

  if (first.setActiveAccount === undefined) throw new Error('Expected account selection support')
  await first.setActiveAccount('U123')

  expect(fetchMock).toHaveBeenCalled()
  const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
  expect(headers['x-tradescript-csrf']).toBe('first-session-token')
})

it('keeps requests tied to the connection generation that created the adapter', async () => {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          connectionStatus: 'connected',
          accounts: [],
          positions: [],
          executions: [],
          messages: [],
          orders: [],
        }),
      ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const broker = createIbkrHttpBrokerAdapter({
    executionEnvironment: 'paper',
    connectionGeneration: 'original-connection',
  })
  await broker.setActiveAccount?.('DU-test')
  expect(fetchMock.mock.calls[0]?.[1]?.headers['x-tradescript-connection']).toBe(
    'original-connection',
  )
})
