import {
  type TradeScriptBootstrapResponse,
  TradeScriptBootstrapResponseSchema,
} from '@ibkr-terminal/contracts'
import type { TradeScriptSdk } from '@tradescript/pro/sdk'

/** Replace the mounted SDK authority in place; refreshing the gateway alone is insufficient. */
export function followSdkLease(
  sdk: Pick<TradeScriptSdk, 'replaceLease'>,
  initial: TradeScriptBootstrapResponse,
  signal: AbortSignal,
  onUnavailable: (message: string) => void,
): () => void {
  let current = initial
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    signal.removeEventListener('abort', stop)
  }
  const unavailable = () => {
    if (stopped || signal.aborted) return
    stop()
    onUnavailable(
      'TradeScript browser authorization could not be renewed. Retry the workstation or restore SDK access.',
    )
  }
  const armExpiry = () => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    expiryTimer = setTimeout(unavailable, Math.max(0, Date.parse(current.expiresAt) - Date.now()))
  }
  const schedule = (delay: number) => {
    if (stopped || signal.aborted) return
    timer = setTimeout(() => void refresh(), Math.max(100, delay))
  }
  const refresh = async () => {
    let replacementFailed = false
    let authorizationDenied = false
    try {
      const response = await fetch('/api/v1/tradescript/bootstrap', {
        credentials: 'same-origin',
        headers: { 'x-tradescript-client': 'terminal-v1' },
        signal,
      })
      authorizationDenied = response.status === 401 || response.status === 403
      if (!response.ok) throw new Error('TradeScript browser authorization could not be renewed.')
      const next = TradeScriptBootstrapResponseSchema.parse(await response.json())
      if (stopped || signal.aborted) return
      if (next.lease !== current.lease) {
        replacementFailed = true
        await sdk.replaceLease(next.lease)
        replacementFailed = false
      }
      if (stopped || signal.aborted) return
      current = next
      armExpiry()
      schedule(Math.min(30_000, Math.max(5_000, Date.parse(current.renewAfter) - Date.now())))
    } catch {
      if (stopped || signal.aborted) return
      const remaining = Date.parse(current.expiresAt) - Date.now()
      if (authorizationDenied || replacementFailed || remaining <= 0) {
        unavailable()
      } else schedule(Math.min(5_000, remaining))
    }
  }
  signal.addEventListener('abort', stop, { once: true })
  if (!signal.aborted) armExpiry()
  schedule(Math.min(30_000, Date.parse(current.renewAfter) - Date.now()))
  return stop
}
