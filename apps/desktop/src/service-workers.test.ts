import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { ServiceWorkers } from './service-workers.js'

function serviceWorker(start: string, close: string) {
  return new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    import('@ibkr-terminal/service-runtime').then(({ runService }) => runService(async () => {
      ${start}
      return { async close() { ${close} } };
    }));
  `,
    { eval: true, stderr: true },
  )
}

describe('desktop service ownership', () => {
  it('waits for asynchronous service cleanup and closes only once', async () => {
    const failure = vi.fn()
    const services = new ServiceWorkers(failure)
    const worker = serviceWorker(
      '',
      `await new Promise(r => setTimeout(r, 30)); parentPort.postMessage('cleaned');`,
    )
    const messages: unknown[] = []
    worker.on('message', (message) => messages.push(message))
    services.add(worker)
    try {
      await services.ready()
      const closing = services.close()
      expect(services.close()).toBe(closing)
      expect(await closing).toBe(true)
      expect(messages.filter((value) => value === 'cleaned')).toHaveLength(1)
      expect(failure).not.toHaveBeenCalled()
    } finally {
      await services.close()
    }
  })

  it('honors a stop requested before startup finishes', async () => {
    const services = new ServiceWorkers(vi.fn())
    const worker = serviceWorker(
      `await new Promise(r => setTimeout(r, 50));`,
      `parentPort.postMessage('cleaned');`,
    )
    const cleaned = once(worker, 'message')
    services.add(worker)
    expect(await services.close()).toBe(true)
    expect((await cleaned)[0]).toBe('cleaned')
  })

  it('reports unexpected exits, including zero, and rejects incomplete startup', async () => {
    const failure = vi.fn()
    const services = new ServiceWorkers(failure)
    services.add(new Worker('process.exit(0)', { eval: true }))
    await expect(services.ready()).rejects.toThrow('before becoming ready')
    expect(failure).toHaveBeenCalledOnce()
    await services.close()
  })

  it('keeps service startup and cleanup failures nonzero', async () => {
    for (const [start, close] of [
      [`throw new Error('startup');`, ''],
      ['', `throw new Error('cleanup');`],
    ]) {
      const services = new ServiceWorkers(vi.fn())
      services.add(serviceWorker(start ?? '', close ?? ''))
      try {
        await services.ready()
      } catch {
        /* Startup failure is expected. */
      }
      expect(await services.close()).toBe(false)
    }
  })

  it('terminates an unresponsive worker after the shutdown deadline', async () => {
    const services = new ServiceWorkers(vi.fn(), 50)
    services.add(
      new Worker(
        `require('node:worker_threads').parentPort.postMessage({ type: 'ready' }); setInterval(() => {}, 1000)`,
        { eval: true },
      ),
    )
    await services.ready()
    expect(await services.close()).toBe(false)
  })
})
