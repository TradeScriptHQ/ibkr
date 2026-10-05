import {
  SystemStatusResponseSchema,
  TradeScriptBootstrapResponseSchema,
} from '@ibkr-terminal/contracts'
import { readConnection } from './connection-client.js'
import { bootstrapBrowserSession } from './terminal-session.js'
import { type WorkstationLoadingState, workstationLoading } from './workstation-startup.js'

/** Resolve authorization and broker readiness before allocating SDK resources. */
export async function authorizeWorkstation(
  signal: AbortSignal,
  mockMode: boolean,
  onProgress: (state: WorkstationLoadingState) => void,
) {
  // Each startup attempt must recover a cookie invalidated by a gateway reload/expiry.
  // The gateway resumes a valid session, preserving other tabs' CSRF tokens.
  onProgress(workstationLoading('authorization'))
  const session = await bootstrapBrowserSession(true)
  signal.throwIfAborted()

  const requestHeaders = { 'x-tradescript-client': 'terminal-v1' }
  const [statusResponse, sdkBootstrapResponse] = await Promise.all([
    fetch('/api/v1/status', {
      credentials: 'same-origin',
      headers: requestHeaders,
      signal: signal,
    }),
    fetch('/api/v1/tradescript/bootstrap', {
      credentials: 'same-origin',
      headers: requestHeaders,
      signal: signal,
    }),
  ])
  if (!statusResponse.ok) throw new Error('Gateway readiness is unavailable.')
  if (!sdkBootstrapResponse.ok) {
    throw new Error('TradeScript browser authorization is unavailable.')
  }
  let status = SystemStatusResponseSchema.parse(await statusResponse.json())
  const bootstrap = TradeScriptBootstrapResponseSchema.parse(await sdkBootstrapResponse.json())
  onProgress(workstationLoading('connection', mockMode ? 'Preparing local simulation…' : undefined))
  // The lease exchange may finish after the concurrent status request took its snapshot.
  if (!mockMode && !status.ready) {
    const response = await fetch('/api/v1/status', {
      credentials: 'same-origin',
      headers: requestHeaders,
      signal,
    })
    if (!response.ok) throw new Error('Gateway readiness is unavailable.')
    status = SystemStatusResponseSchema.parse(await response.json())
  }
  const connection = mockMode ? undefined : await readConnection()
  const deadline = Date.now() + 5_000
  while (
    !mockMode &&
    !status.ready &&
    !signal.aborted &&
    Date.now() < deadline &&
    status.requirements.some(
      (item) =>
        item.id === 'tws-session' &&
        ['connecting', 'reconciling', 'disconnected', 'degraded'].includes(item.state),
    )
  ) {
    onProgress(
      workstationLoading(
        'connection',
        status.requirements.find((item) => item.id === 'tws-session')?.message ??
          'Waiting for the broker connection…',
      ),
    )
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, 500)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    signal.throwIfAborted()
    const response = await fetch('/api/v1/status', {
      headers: requestHeaders,
      signal: signal,
    })
    if (!response.ok) throw new Error('Gateway readiness is unavailable.')
    status = SystemStatusResponseSchema.parse(await response.json())
  }
  if (!mockMode && !status.ready) {
    const blocked = status.requirements.find((requirement) => requirement.state !== 'ready')
    throw new Error(blocked?.message ?? 'The workstation is not ready.')
  }
  signal.throwIfAborted()

  return { session, status, bootstrap, connection }
}
