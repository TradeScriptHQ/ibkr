import type { APIRequestContext, BrowserContext } from '@playwright/test'
import { isBrokerMutation } from './order-safety.js'
import { TERMINAL_ORIGIN } from './session.js'

/** Wrap only the test request context; authentication tests retain their own cookies. */
export function guardBrokerRequests(
  request: APIRequestContext,
  mutations: boolean,
): APIRequestContext {
  return new Proxy(request, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const url = typeof args[0] === 'string' ? args[0] : undefined
        const method =
          property === 'fetch'
            ? ((args[1] as { method?: string } | undefined)?.method ?? 'GET')
            : String(property).toUpperCase()
        if (!mutations && url && isBrokerMutation(method, url)) {
          throw new Error(
            `Read-only E2E blocked ${method} ${new URL(url, TERMINAL_ORIGIN).pathname}`,
          )
        }
        return Reflect.apply(value, target, args)
      }
    },
  })
}

export async function guardBrowserMutations(
  context: BrowserContext,
  mutations: boolean,
): Promise<string[]> {
  const blocked: string[] = []
  await context.route('**/api/v1/ibkr/**', async (route) => {
    const request = route.request()
    if (!mutations && isBrokerMutation(request.method(), request.url())) {
      blocked.push(`${request.method()} ${new URL(request.url()).pathname}`)
      await route.abort('blockedbyclient')
    } else await route.fallback()
  })
  return blocked
}
