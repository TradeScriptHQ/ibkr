import { describe, expect, it } from 'vitest'
import { EventStream } from '../src/events/event-stream.js'

describe('gateway event stream', () => {
  it('publishes monotonic cursors and supports resumable backlogs', () => {
    const stream = new EventStream(3)
    stream.publish({ type: 'heartbeat', serverTime: new Date(0).toISOString() })
    stream.publish({ type: 'heartbeat', serverTime: new Date(1).toISOString() })
    const backlog = stream.backlog(stream.generation, 1)
    expect(backlog.status).toBe('ok')
    if (backlog.status === 'ok') expect(backlog.events.map(({ cursor }) => cursor)).toEqual([2])
  })

  it('requires a resnapshot after a generation mismatch or buffer gap', () => {
    const stream = new EventStream(1)
    stream.publish({ type: 'heartbeat', serverTime: new Date(0).toISOString() })
    stream.publish({ type: 'heartbeat', serverTime: new Date(1).toISOString() })
    expect(stream.backlog('old-generation', 0)).toMatchObject({
      status: 'resync-required',
      reason: 'generation-changed',
    })
    expect(stream.backlog(stream.generation, 0)).toMatchObject({
      status: 'resync-required',
      reason: 'cursor-gap',
    })
  })
})
