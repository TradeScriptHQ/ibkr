import {
  SystemStatusResponseSchema,
  TradeScriptBootstrapResponseSchema,
} from '@ibkr-terminal/contracts'
import { readConnection } from './connection-client.js'
import { bootstrapBrowserSession } from './terminal-session.js'

/** Resolve authorization and broker readiness before allocating SDK resources. */
export async function authorizeWorkstation(
  signal: AbortSignal,
  mockMode: boolean,
  onProgress: (state: { state: 'loading'; message: string }) => void,
) {
  const session = await bootstrapBrowserSession()
  signal.throwIfAborted()

  onProgress({
    state: 'loading',
    message: mockMode ? 'Starting the isolated local simulation…' : 'Connecting to TWS…',
  })
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
  const connection = mockMode ? undefined : await readConnection()
  while (
    !mockMode &&
    !status.ready &&
    !signal.aborted &&
    status.requirements.some(
      (item) =>
        item.id === 'tws-session' && (item.state === 'connecting' || item.state === 'reconciling'),
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    signal.throwIfAborted()
    const response = await fetch('/api/v1/status', {
      headers: requestHeaders,
      signal: signal,
    })
    if (!response.ok) throw new Error('Gateway readiness is unavailable.')
    status = SystemStatusResponseSchema.parse(await response.json())
  }
  const bootstrap = TradeScriptBootstrapResponseSchema.parse(await sdkBootstrapResponse.json())
  if (!mockMode && !status.ready) {
    const blocked = status.requirements.find((requirement) => requirement.state !== 'ready')
    throw new Error(blocked?.message ?? 'The workstation is not ready.')
  }
  signal.throwIfAborted()

  return { session, status, bootstrap, connection }
}
