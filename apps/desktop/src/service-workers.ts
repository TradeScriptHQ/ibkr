import type { Worker } from 'node:worker_threads'

/** Owns worker readiness and bounded, graceful shutdown, including partial startup. */
export class ServiceWorkers {
  private readonly workers: Array<{
    worker: Worker
    exited: Promise<number>
    ready: Promise<void>
  }> = []
  private stopping = false
  private closing?: Promise<boolean>

  constructor(
    private readonly onFailure: () => void,
    private readonly stopTimeoutMs = 3_000,
  ) {}

  add(worker: Worker): void {
    if (this.stopping) throw new Error('Local services are stopping')
    let ready = false
    let resolveReady: () => void
    let rejectReady: (error: Error) => void
    const readiness = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // A worker may fail before the caller starts waiting for the entire group.
    void readiness.catch(() => {})
    worker.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'ready'
      ) {
        ready = true
        resolveReady()
      }
    })
    worker.once('error', () => {
      rejectReady(new Error('A local service failed'))
      if (!this.stopping) this.onFailure()
    })
    const exited = new Promise<number>((resolve) =>
      worker.once('exit', (code) => {
        if (!ready) rejectReady(new Error('A local service exited before becoming ready'))
        resolve(code)
        if (!this.stopping) this.onFailure()
      }),
    )
    this.workers.push({ worker, ready: readiness, exited })
  }

  async ready(timeoutMs = 10_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.all(this.workers.map(({ ready }) => ready)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Local services did not start in time')),
            timeoutMs,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  close(): Promise<boolean> {
    this.stopping = true
    this.closing ??= Promise.all(
      this.workers.map(async ({ worker, exited }) => {
        let timer: NodeJS.Timeout | undefined
        try {
          worker.postMessage({ type: 'stop' })
          const code = await Promise.race([
            exited,
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), this.stopTimeoutMs)
            }),
          ])
          if (code !== undefined) return code === 0
          await worker.terminate()
          return false
        } finally {
          clearTimeout(timer)
        }
      }),
    ).then((results) => results.every(Boolean))
    return this.closing
  }
}
