import {
  type SessionBootstrapResponse,
  SessionBootstrapResponseSchema,
} from '@ibkr-terminal/contracts'
import type { TradeScriptSdk, TradeScriptSdkProducts } from '@tradescript/pro/sdk'
import { createTradeScriptSdk } from '@tradescript/pro/sdk/core'

export const CLIENT_HEADERS = {
  'content-type': 'application/json',
  'x-tradescript-client': 'terminal-v1',
}

const SOURCE_SDK_MODE = import.meta.env.VITE_TRADESCRIPT_SDK_SOURCE_MODE

let sessionBootstrapPromise: Promise<SessionBootstrapResponse> | undefined
let sessionBootstrapPending = false
let settledSession: SessionBootstrapResponse | undefined
const sessionChangeListeners = new Set<() => void>()

/** Captured request tokens and connections must be rebuilt when local authority changes. */
export function subscribeBrowserSessionChanges(listener: () => void): () => void {
  sessionChangeListeners.add(listener)
  return () => {
    sessionChangeListeners.delete(listener)
  }
}

export function bootstrapBrowserSession(refresh = false): Promise<SessionBootstrapResponse> {
  if (
    !sessionBootstrapPending &&
    (refresh || (settledSession && Date.parse(settledSession.expiresAt) <= Date.now()))
  )
    sessionBootstrapPromise = undefined
  if (sessionBootstrapPromise !== undefined) return sessionBootstrapPromise
  sessionBootstrapPending = true
  sessionBootstrapPromise = fetch('/api/v1/session/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: CLIENT_HEADERS,
    body: '{}',
    signal: AbortSignal.timeout(5000),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error('The secure local session could not be started.')
      const session = SessionBootstrapResponseSchema.parse(await response.json())
      const changed = settledSession !== undefined && settledSession.csrfToken !== session.csrfToken
      settledSession = session
      if (changed) for (const listener of sessionChangeListeners) listener()
      return session
    })
    .catch((error: unknown) => {
      sessionBootstrapPromise = undefined
      throw error
    })
    .finally(() => {
      sessionBootstrapPending = false
    })
  return sessionBootstrapPromise
}

type TerminalTradeScriptSdk = TradeScriptSdkProducts & {
  close(): void
  /** Packaged deployments own leases; the explicit source development facade does not. */
  authorization: Pick<TradeScriptSdk, 'replaceLease' | 'snapshot'> | undefined
}

export async function createTerminalTradeScriptSdk(lease: string): Promise<TerminalTradeScriptSdk> {
  if (!SOURCE_SDK_MODE) {
    const sdk = await createTradeScriptSdk({ lease })
    return Object.freeze({ ...sdk, authorization: sdk })
  }
  const { createSourceDevelopmentSdk } = await import('virtual:tradescript-source-development-sdk')
  const sdk = await createSourceDevelopmentSdk()
  return Object.freeze({ ...sdk, close: () => undefined, authorization: undefined })
}
