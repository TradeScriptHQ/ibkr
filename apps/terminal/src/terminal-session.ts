import {
  type SessionBootstrapResponse,
  SessionBootstrapResponseSchema,
} from '@ibkr-terminal/contracts'
import type { TradeScriptSdkProducts } from '@tradescript/pro/sdk'
import { createTradeScriptSdk } from '@tradescript/pro/sdk/core'

export const CLIENT_HEADERS = {
  'content-type': 'application/json',
  'x-tradescript-client': 'terminal-v1',
}

const SOURCE_SDK_MODE = import.meta.env.VITE_TRADESCRIPT_SDK_SOURCE_MODE

let sessionBootstrapPromise: Promise<SessionBootstrapResponse> | undefined

export function bootstrapBrowserSession(): Promise<SessionBootstrapResponse> {
  if (sessionBootstrapPromise !== undefined) return sessionBootstrapPromise
  sessionBootstrapPromise = fetch('/api/v1/session/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: CLIENT_HEADERS,
    body: '{}',
  })
    .then(async (response) => {
      if (!response.ok) throw new Error('The secure local session could not be started.')
      return SessionBootstrapResponseSchema.parse(await response.json())
    })
    .catch((error: unknown) => {
      sessionBootstrapPromise = undefined
      throw error
    })
  return sessionBootstrapPromise
}

type TerminalTradeScriptSdk = TradeScriptSdkProducts & { close(): void }

export async function createTerminalTradeScriptSdk(lease: string): Promise<TerminalTradeScriptSdk> {
  if (!SOURCE_SDK_MODE) return createTradeScriptSdk({ lease })
  const { createSourceDevelopmentSdk } = await import('virtual:tradescript-source-development-sdk')
  const sdk = await createSourceDevelopmentSdk()
  return Object.freeze({ ...sdk, close: () => undefined })
}
