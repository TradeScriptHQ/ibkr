import { isMainThread, parentPort } from 'node:worker_threads'

export interface LocalService {
  close(): void | Promise<void>
}

/** Both CLI signals and desktop worker messages use the service's own cleanup. */
export async function runService(start: () => Promise<LocalService>): Promise<void> {
  const service = start()
  let closing: Promise<void> | undefined
  const stop = () => {
    closing ??= (async () => {
      try {
        await (await service).close()
        process.exit(0)
      } catch {
        process.stderr.write('The local service could not stop cleanly.\n')
        process.exit(1)
      }
    })()
    return closing
  }
  if (isMainThread) {
    process.once('SIGINT', () => void stop())
    process.once('SIGTERM', () => void stop())
  } else {
    parentPort?.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'stop'
      )
        void stop()
    })
  }
  try {
    await service
    if (!closing) parentPort?.postMessage({ type: 'ready' })
  } catch {
    process.stderr.write('The local service failed to start.\n')
    process.exit(1)
  }
}
