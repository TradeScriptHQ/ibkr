import { randomUUID } from 'node:crypto'
import type { AgenticSurfaceAdapterApi } from '@tradescript/pro/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { connectTradeScriptMcp } from './browser-bridge.js'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const CONSUMER_ID = '22222222-2222-4222-8222-222222222222'
const MCP_URL = 'http://127.0.0.1:41234/mcp'
const BRIDGE_URL = 'ws://127.0.0.1:41235/bridge'

interface Harness {
  readonly invocations: Array<Record<string, unknown>>
  readonly sent: Array<Record<string, unknown>>
  readonly states: Array<Record<string, unknown>>
  readonly subscribed: string[]
  readonly unsubscribed: string[]
  readonly dispose: () => void
  socket(): unknown
  open(): void
  close(): void
  deliver(message: Record<string, unknown>): void
  respond(id: string, result: unknown): void
  emitChannel(channelId: string, value: unknown): void
}

function harness(agentic: Partial<AgenticSurfaceAdapterApi>): Harness {
  const invocations: Array<Record<string, unknown>> = []
  const sent: Array<Record<string, unknown>> = []
  const states: Array<Record<string, unknown>> = []
  const listeners = new Map<string, Set<(event: { data?: unknown }) => void>>()
  // Channel callbacks are keyed by channel id so a test can push a value through one subscription.
  const channelCallbacks = new Map<string, (value: unknown) => void>()
  const subscribed: string[] = []
  const unsubscribed: string[] = []
  let socket: FakeSocket | undefined

  class FakeSocket {
    static readonly OPEN = 1
    readonly OPEN = 1
    readyState = 1
    constructor() {
      socket = this
    }
    addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    }
    send(payload: string): void {
      sent.push(JSON.parse(payload) as Record<string, unknown>)
    }
    close(): void {
      this.readyState = 3
      for (const listener of listeners.get('close') ?? []) listener({})
    }
  }

  const emit = (type: string, event: { data?: unknown }): void => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }

  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 201,
    json: async () => ({
      sessionId: SESSION_ID,
      mcpUrl: MCP_URL,
      bridgeUrl: BRIDGE_URL,
      bridgeToken: 'x'.repeat(43),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  }))
  // Real UUIDs, because the bridge keys subscriptions and requests by them. A constant stub would
  // make every subscription overwrite the same entry and hide cap behaviour.
  vi.stubGlobal('crypto', { randomUUID: () => randomUUID() })
  // The bridge schedules reconnects on `window`, so the node test environment needs that global.
  vi.stubGlobal('window', { setTimeout, clearTimeout })

  // Recording wrappers stay in front of any per-test override, so every assertion can inspect what
  // the SDK actually received while a test still controls the outcome.
  const recordInvocation = async (request: Record<string, unknown>): Promise<unknown> => {
    invocations.push(request)
    const override = agentic.invokeAnyGuarded as
      | ((request: Record<string, unknown>) => Promise<unknown>)
      | undefined
    if (override !== undefined) return await override(request)
    return { operationId: request.operationId, origin: 'mcp', value: {} }
  }

  const adapter = {
    ready: async () => undefined,
    listSurfaces: () => [],
    listEffectiveControls: () => [],
    subscribeAnyChannel: (request: { channelId: string }, callback: (value: unknown) => void) => {
      subscribed.push(request.channelId)
      channelCallbacks.set(request.channelId, callback)
      return () => {
        unsubscribed.push(request.channelId)
        channelCallbacks.delete(request.channelId)
      }
    },
    ...agentic,
    invokeAnyGuarded: recordInvocation,
  } as unknown as AgenticSurfaceAdapterApi

  const dispose = connectTradeScriptMcp({
    agentic: adapter,
    onState: (state) => states.push(state as unknown as Record<string, unknown>),
  })

  return {
    invocations,
    sent,
    states,
    subscribed,
    unsubscribed,
    dispose,
    socket: () => socket,
    open: () => emit('open', {}),
    close: () => socket?.close(),
    deliver: (message) => emit('message', { data: JSON.stringify(message) }),
    respond: (id, result) =>
      emit('message', { data: JSON.stringify({ type: 'response', id, result }) }),
    emitChannel: (channelId, value) => channelCallbacks.get(channelId)?.(value),
  }
}

async function attached(agentic: Partial<AgenticSurfaceAdapterApi> = {}): Promise<Harness> {
  const test = harness(agentic)
  // `connect()` awaits the adapter and the bootstrap fetch before it registers the socket
  // listeners, so wait for the socket to exist rather than for the first state.
  await vi.waitFor(() => {
    expect(test.socket()).toBeDefined()
  })
  test.open()
  await vi.waitFor(() => {
    expect(test.sent.some(({ type }) => type === 'attach')).toBe(true)
  })
  test.deliver({ type: 'attached', sessionId: SESSION_ID })
  return test
}

function request(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { type: 'request', id: '44444444-4444-4444-8444-444444444444', method, params }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('attributes a single call to the calling MCP client, not the browser session', async () => {
  const test = await attached()
  try {
    test.deliver(
      request('call', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        target: { scope: 'session' },
        controlId: 'trading.getState',
        args: [],
      }),
    )
    await vi.waitFor(() => expect(test.invocations).toHaveLength(1))
    expect(test.invocations[0]?.operationNamespace).toBe(`mcp:${CONSUMER_ID}`)
    expect(test.invocations[0]?.operationNamespace).not.toBe(`mcp:${SESSION_ID}`)
  } finally {
    test.dispose()
  }
})

it('attributes every call in a batch to the same MCP client', async () => {
  const test = await attached()
  try {
    test.deliver(
      request('batch', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        calls: [
          { target: { scope: 'session' }, controlId: 'trading.getState', args: [] },
          { target: { scope: 'session' }, controlId: 'trading.getState', args: [] },
        ],
      }),
    )
    await vi.waitFor(() => expect(test.invocations).toHaveLength(2))
    for (const invocation of test.invocations) {
      expect(invocation.operationNamespace).toBe(`mcp:${CONSUMER_ID}`)
    }
  } finally {
    test.dispose()
  }
})

it('ignores a per-call consumer identity that disagrees with the caller', async () => {
  const test = await attached()
  try {
    test.deliver(
      request('batch', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        calls: [
          {
            target: { scope: 'session' },
            controlId: 'trading.getState',
            args: [],
            consumerId: 'attacker-supplied-identity',
          },
        ],
      }),
    )
    await vi.waitFor(() => expect(test.invocations).toHaveLength(1))
    expect(test.invocations[0]?.operationNamespace).toBe(`mcp:${CONSUMER_ID}`)
  } finally {
    test.dispose()
  }
})

it('rejects a delegated request that carries no consumer identity', async () => {
  const test = await attached()
  try {
    test.deliver(
      request('call', {
        sessionId: SESSION_ID,
        target: { scope: 'session' },
        controlId: 'trading.getState',
        args: [],
      }),
    )
    await vi.waitFor(() => {
      expect(test.sent.some(({ type }) => type === 'response')).toBe(true)
    })
    const response = test.sent.find(({ type }) => type === 'response')
    expect(response?.error).toMatchObject({ code: 'CONSUMER_IDENTITY_MISSING' })
    expect(test.invocations).toHaveLength(0)
  } finally {
    test.dispose()
  }
})

it('reports the bootstrap endpoint instead of a guessed port', async () => {
  const test = await attached()
  try {
    expect(test.states[0]?.endpoint).not.toBe(MCP_URL)
    expect(test.states.at(-1)).toMatchObject({ phase: 'connected', endpoint: MCP_URL })
  } finally {
    test.dispose()
  }
})

it('runs batch calls in order and stops at the first rejection by default', async () => {
  const test = await attached({
    invokeAnyGuarded: (async (request: Record<string, unknown>) => {
      if (request.controlId === 'trading.fail') throw new Error('control rejected')
      return { operationId: request.operationId, origin: 'mcp', value: {} }
    }) as never,
  })
  try {
    test.deliver(
      request('batch', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        calls: [
          { target: { scope: 'session' }, controlId: 'trading.first', args: [] },
          { target: { scope: 'session' }, controlId: 'trading.fail', args: [] },
          { target: { scope: 'session' }, controlId: 'trading.never', args: [] },
        ],
      }),
    )
    await vi.waitFor(() => {
      expect(test.sent.some(({ type }) => type === 'response')).toBe(true)
    })
    const result = test.sent.find(({ type }) => type === 'response')?.result as {
      results: Array<{ index: number; status: string }>
      stoppedEarly: boolean
    }
    expect(result.results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected'])
    expect(result.stoppedEarly).toBe(true)
    expect(test.invocations.map(({ controlId }) => controlId)).toEqual([
      'trading.first',
      'trading.fail',
    ])
  } finally {
    test.dispose()
  }
})

it('continues past a rejection when stopOnError is false', async () => {
  const test = await attached({
    invokeAnyGuarded: (async (request: Record<string, unknown>) => {
      if (request.controlId === 'trading.fail') throw new Error('control rejected')
      return { operationId: request.operationId, origin: 'mcp', value: {} }
    }) as never,
  })
  try {
    test.deliver(
      request('batch', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        stopOnError: false,
        calls: [
          { target: { scope: 'session' }, controlId: 'trading.fail', args: [] },
          { target: { scope: 'session' }, controlId: 'trading.after', args: [] },
        ],
      }),
    )
    await vi.waitFor(() => {
      expect(test.sent.some(({ type }) => type === 'response')).toBe(true)
    })
    const result = test.sent.find(({ type }) => type === 'response')?.result as {
      results: Array<{ status: string }>
      stoppedEarly: boolean
    }
    expect(result.results.map(({ status }) => status)).toEqual(['rejected', 'fulfilled'])
    expect(result.stoppedEarly).toBe(false)
  } finally {
    test.dispose()
  }
})

it('rejects a request naming a different browser session', async () => {
  const test = await attached()
  try {
    test.deliver(
      request('call', {
        sessionId: '99999999-9999-4999-8999-999999999999',
        consumerId: CONSUMER_ID,
        target: { scope: 'session' },
        controlId: 'trading.getState',
        args: [],
      }),
    )
    await vi.waitFor(() => {
      expect(test.sent.some(({ type }) => type === 'response')).toBe(true)
    })
    const response = test.sent.find(({ type }) => type === 'response')
    expect(response?.error).toMatchObject({ code: 'SESSION_MISMATCH' })
    expect(test.invocations).toHaveLength(0)
  } finally {
    test.dispose()
  }
})

it('streams subscription events with monotonic sequences and polls after a cursor', async () => {
  const test = await attached()
  try {
    test.deliver(
      request('subscribe', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        action: 'start',
        target: { scope: 'session' },
        bindings: [{ channelId: 'trading.orders' }],
      }),
    )
    await vi.waitFor(() => expect(test.subscribed).toEqual(['trading.orders']))
    const subscriptionId = test.sent.find(({ type }) => type === 'response')?.result as {
      subscriptionId: string
    }
    expect(subscriptionId.subscriptionId).toBeDefined()

    test.emitChannel('trading.orders', { id: 'a' })
    test.emitChannel('trading.orders', { id: 'b' })

    test.deliver(
      request('subscribe', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        action: 'poll',
        subscriptionId: subscriptionId.subscriptionId,
      }),
    )
    await vi.waitFor(() => {
      expect(test.sent.filter(({ type }) => type === 'response')).toHaveLength(2)
    })
    const poll = test.sent.filter(({ type }) => type === 'response')[1]?.result as {
      events: Array<{ sequence: number; value: unknown }>
      nextSequence: number
      latestSequence: number
    }
    expect(poll.events.map(({ sequence }) => sequence)).toEqual([1, 2])
    expect(poll.nextSequence).toBe(2)
    expect(poll.latestSequence).toBe(2)
  } finally {
    test.dispose()
  }
})

it('stops a subscription and releases its channels', async () => {
  const test = await attached()
  try {
    test.deliver(
      request('subscribe', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        action: 'start',
        target: { scope: 'session' },
        bindings: [{ channelId: 'trading.orders' }],
      }),
    )
    await vi.waitFor(() => expect(test.subscribed).toEqual(['trading.orders']))
    const started = test.sent.find(({ type }) => type === 'response')
    if (started === undefined) throw new Error('The subscribe start produced no response')
    const { subscriptionId } = started.result as { subscriptionId: string }

    test.deliver(
      request('subscribe', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        action: 'stop',
        subscriptionId,
      }),
    )
    await vi.waitFor(() => expect(test.unsubscribed).toEqual(['trading.orders']))
    expect(test.sent.filter(({ type }) => type === 'response')).toHaveLength(2)
  } finally {
    test.dispose()
  }
})

it('rejects an unknown subscription id', async () => {
  const test = await attached()
  try {
    test.deliver(
      request('subscribe', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        action: 'stop',
        subscriptionId: '55555555-5555-4555-8555-555555555555',
      }),
    )
    await vi.waitFor(() => {
      expect(test.sent.some(({ type }) => type === 'response')).toBe(true)
    })
    const response = test.sent.find(({ type }) => type === 'response')
    expect(response?.error).toMatchObject({ code: 'UNKNOWN_SUBSCRIPTION' })
  } finally {
    test.dispose()
  }
})

it('caps how many subscriptions one session can hold', async () => {
  const test = await attached()
  try {
    for (let index = 0; index < 32; index += 1) {
      test.deliver(
        request('subscribe', {
          sessionId: SESSION_ID,
          consumerId: CONSUMER_ID,
          action: 'start',
          target: { scope: 'session' },
          bindings: [{ channelId: `channel.${index}` }],
        }),
      )
    }
    await vi.waitFor(() => expect(test.subscribed).toHaveLength(32))

    test.deliver(
      request('subscribe', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        action: 'start',
        target: { scope: 'session' },
        bindings: [{ channelId: 'channel.overflow' }],
      }),
    )
    await vi.waitFor(() => {
      expect(test.sent.filter(({ type }) => type === 'response')).toHaveLength(33)
    })
    const responses = test.sent.filter(({ type }) => type === 'response')
    const last = responses.at(-1)
    expect(last?.error).toMatchObject({ code: 'SUBSCRIPTION_LIMIT' })
    expect(test.subscribed).not.toContain('channel.overflow')
  } finally {
    test.dispose()
  }
})

it('releases subscriptions when the socket closes', async () => {
  const test = await attached()
  try {
    test.deliver(
      request('subscribe', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        action: 'start',
        target: { scope: 'session' },
        bindings: [{ channelId: 'trading.orders' }],
      }),
    )
    await vi.waitFor(() => expect(test.subscribed).toEqual(['trading.orders']))
    test.close()
    await vi.waitFor(() => expect(test.unsubscribed).toEqual(['trading.orders']))
    expect(test.states.at(-1)).toMatchObject({ phase: 'disconnected' })
  } finally {
    test.dispose()
  }
})

it('reports an error state when the adapter is not ready', async () => {
  const test = harness({
    ready: (async () => {
      throw new Error('adapter unavailable')
    }) as never,
  })
  try {
    await vi.waitFor(() => {
      expect(test.states.at(-1)).toMatchObject({ phase: 'error' })
    })
    expect(test.states.at(-1)?.error).toBe('adapter unavailable')
  } finally {
    test.dispose()
  }
})

it('stops a batch at its wall-clock budget instead of running every call', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const test = await attached({
    invokeAnyGuarded: (async (request: Record<string, unknown>) => {
      // Each call consumes more than a third of the budget, so the third cannot start.
      vi.advanceTimersByTime(50_000)
      return { operationId: request.operationId, origin: 'mcp', value: {} }
    }) as never,
  })
  try {
    test.deliver(
      request('batch', {
        sessionId: SESSION_ID,
        consumerId: CONSUMER_ID,
        calls: [
          { target: { scope: 'session' }, controlId: 'trading.one', args: [] },
          { target: { scope: 'session' }, controlId: 'trading.two', args: [] },
          { target: { scope: 'session' }, controlId: 'trading.three', args: [] },
          { target: { scope: 'session' }, controlId: 'trading.four', args: [] },
        ],
      }),
    )
    await vi.waitFor(() => {
      expect(test.sent.some(({ type }) => type === 'response')).toBe(true)
    })
    const result = test.sent.find(({ type }) => type === 'response')?.result as {
      results: unknown[]
      stoppedEarly: boolean
      budgetExhausted?: boolean
      reason?: string
    }
    expect(result.budgetExhausted).toBe(true)
    expect(result.stoppedEarly).toBe(true)
    expect(result.reason).toContain('budget')
    expect(result.results.length).toBeLessThan(4)
    expect(test.invocations.length).toBe(result.results.length)
  } finally {
    test.dispose()
    vi.useRealTimers()
  }
})
