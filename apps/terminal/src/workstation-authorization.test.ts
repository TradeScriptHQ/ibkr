import type { SystemStatusResponse } from '@ibkr-terminal/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { authorizeWorkstation } from './workstation-authorization.js'

vi.mock('./terminal-session.js', () => ({
  bootstrapBrowserSession: async () => ({ csrfToken: 'test-only-session' }),
}))
vi.mock('./connection-client.js', () => ({
  readConnection: async () => ({ generation: 'test-generation' }),
}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const bootstrap = {
  lease: 'x'.repeat(64),
  leaseType: 'TradeScript-Deployment-Lease',
  sdkVersion: '0.1.34',
  customerBuildFingerprint: `tsfp1_${'a'.repeat(32)}`,
  expiresAt: '2026-10-01T00:00:00.000Z',
  renewAfter: '2026-09-30T23:00:00.000Z',
  paperTrading: { enabled: false, autonomyMode: 'paper-auto', allowedAccountIds: [] },
}
function status(
  state:
    | 'ready'
    | 'connecting'
    | 'reconciling'
    | 'degraded'
    | 'disconnected'
    | 'error'
    | 'setup-required',
  id = 'tws-session',
  message = 'Waiting for broker recovery',
): SystemStatusResponse {
  return {
    service: 'ibkr-trading-gateway',
    version: 'test',
    environment: 'paper',
    ready: state === 'ready',
    tradingEnabled: state === 'ready',
    generatedAt: '2026-09-30T00:00:00.000Z',
    requirements: [{ id, label: 'test', state, message, requiredForTrading: true }],
  }
}
function responses(snapshots: SystemStatusResponse[]) {
  const queue = [...snapshots]
  const mock = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes('tradescript/bootstrap')) return Response.json(bootstrap)
    return Response.json(queue.length > 1 ? queue.shift() : queue[0])
  })
  vi.stubGlobal('fetch', mock)
  return mock
}
it('keeps authorization pending until the SDK lease exchange completes', async () => {
  const leaseResponse = Promise.withResolvers<Response>()
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input) =>
      String(input).includes('tradescript/bootstrap')
        ? leaseResponse.promise
        : Promise.resolve(Response.json(status('ready'))),
    ),
  )
  const progress = vi.fn()
  const result = authorizeWorkstation(new AbortController().signal, false, progress)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      progress: { stage: 'authorization', completed: 1, total: 8 },
    }),
  )
  leaseResponse.resolve(Response.json(bootstrap))
  await result
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      progress: { stage: 'connection', completed: 2, total: 8 },
    }),
  )
})
it('rereads status after the lease bootstrap resolves instead of trusting the earlier pending lease', async () => {
  const mock = responses([status('setup-required', 'tradescript-lease'), status('ready')])
  const result = await authorizeWorkstation(new AbortController().signal, false, vi.fn())
  expect(result.status.ready).toBe(true)
  expect(mock.mock.calls.filter(([input]) => String(input).includes('/status'))).toHaveLength(2)
})
it.each(['degraded', 'disconnected'] as const)(
  'waits through %s until TWS recovers',
  async (state) => {
    vi.useFakeTimers()
    responses([status(state), status(state), status('ready')])
    const progress = vi.fn()
    const result = authorizeWorkstation(new AbortController().signal, false, progress)
    await vi.advanceTimersByTimeAsync(501)
    expect((await result).status.ready).toBe(true)
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Waiting for broker recovery' }),
    )
  },
)
it('aborts a recovery wait without leaving a poll timer', async () => {
  vi.useFakeTimers()
  responses([status('disconnected')])
  const controller = new AbortController()
  const result = authorizeWorkstation(controller.signal, false, vi.fn())
  const rejected = expect(result).rejects.toThrow('test abort')
  await vi.advanceTimersByTimeAsync(1)
  controller.abort(new Error('test abort'))
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})
it('surfaces fatal client conflicts and account setup problems without endless recovery polling', async () => {
  for (const snapshot of [
    status('error', 'tws-session', 'TWS API client ID 7 is already in use.'),
    status('setup-required', 'paper-account', 'Choose allowed accounts'),
  ]) {
    const mock = responses([snapshot])
    await expect(
      authorizeWorkstation(new AbortController().signal, false, vi.fn()),
    ).rejects.toThrow(snapshot.requirements[0]?.message)
    expect(mock).toHaveBeenCalledTimes(3)
  }
})

it('surfaces a broker startup failure immediately without another recovery wait', async () => {
  vi.useFakeTimers()
  const message =
    'IB Gateway connected, but its API did not complete startup within 5 seconds. Gateway may still show a healthy connection. Check IB Gateway, restart it if needed, then retry the workstation.'
  const mock = responses([status('error', 'tws-session', message)])
  let failure: unknown
  const result = authorizeWorkstation(new AbortController().signal, false, vi.fn()).catch(
    (error: unknown) => {
      failure = error
    },
  )
  await vi.advanceTimersByTimeAsync(1)
  expect(failure).toBeInstanceOf(Error)
  expect(failure).toHaveProperty('message', message)
  expect(vi.getTimerCount()).toBe(0)
  expect(mock).toHaveBeenCalledTimes(3)
  await result
})

it('stops a startup wait when the broker reports its deadline failure', async () => {
  vi.useFakeTimers()
  const message = 'IB Gateway connected, but its API did not complete startup within 5 seconds.'
  responses([
    status('connecting', 'tws-session', 'Waiting for IB Gateway API startup.'),
    status('connecting', 'tws-session', 'Waiting for IB Gateway API startup.'),
    status('error', 'tws-session', message),
  ])
  const progress = vi.fn()
  const result = authorizeWorkstation(new AbortController().signal, false, progress)
  const rejected = expect(result).rejects.toThrow(message)
  await vi.advanceTimersByTimeAsync(501)
  await rejected
  expect(progress).toHaveBeenCalledWith({
    state: 'loading',
    message: 'Waiting for IB Gateway API startup.',
    progress: { stage: 'connection', completed: 2, total: 8 },
  })
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['connecting', 'disconnected', 'degraded'] as const)(
  'bounds the %s startup wait to five seconds',
  async (state) => {
    vi.useFakeTimers()
    responses([status(state)])
    let failure: unknown
    const result = authorizeWorkstation(new AbortController().signal, false, vi.fn()).catch(
      (error: unknown) => {
        failure = error
      },
    )
    await vi.advanceTimersByTimeAsync(4_999)
    expect(failure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toHaveProperty('message', 'Waiting for broker recovery')
    expect(vi.getTimerCount()).toBe(0)
    await result
  },
)
