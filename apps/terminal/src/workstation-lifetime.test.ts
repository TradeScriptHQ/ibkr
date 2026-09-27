import { describe, expect, it, vi } from 'vitest'
import { WorkstationLifetime } from './workstation-lifetime.js'

describe('workstation startup ownership', () => {
  it('aborts startup and releases dependent resources before their owners exactly once', async () => {
    const lifetime = new WorkstationLifetime()
    const released: string[] = []
    lifetime.defer(() => {
      released.push('sdk')
    })
    lifetime.defer(async () => {
      await Promise.resolve()
      released.push('adapter')
    })
    lifetime.defer(() => {
      released.push('widget')
    })
    const closing = lifetime.dispose()
    expect(lifetime.controller.signal.aborted).toBe(true)
    await closing
    await lifetime.dispose()
    expect(released).toEqual(['widget', 'adapter', 'sdk'])
  })

  it('releases resources that finish loading after cancellation', async () => {
    const lifetime = new WorkstationLifetime()
    await lifetime.dispose()
    const close = vi.fn()
    lifetime.defer(close)
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
  })

  it('continues releasing resources after a teardown failure', async () => {
    const lifetime = new WorkstationLifetime()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const close = vi.fn()
    lifetime.defer(close)
    lifetime.defer(() => {
      throw new Error('failed')
    })
    await lifetime.dispose()
    expect(close).toHaveBeenCalledOnce()
    log.mockRestore()
  })
})
