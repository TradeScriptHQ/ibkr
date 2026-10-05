import type { APIRequestContext, APIResponse, BrowserContext } from '@playwright/test'
import { isBrokerMutation } from './order-safety.js'
import type { PreparedPaperRequest } from './paper-order-tracker.js'
import { TERMINAL_ORIGIN } from './session.js'

/** Wrap only the test request context; authentication tests retain their own cookies. */
export function guardBrokerRequests(
  request: APIRequestContext,
  mutations: boolean,
  onResponse?: (response: APIResponse, method: string, attemptId?: string) => Promise<void>,
  prepareRequest?: (
    url: string,
    method: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => PreparedPaperRequest,
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
        const options = args[1] as { data?: unknown; headers?: Record<string, string> } | undefined
        const prepared =
          url && prepareRequest
            ? prepareRequest(url, method, options?.data, options?.headers)
            : undefined
        const forwarded = prepared
          ? [args[0], { ...options, data: prepared.body }, ...args.slice(2)]
          : args
        const result = Reflect.apply(value, target, forwarded)
        if (!url || !onResponse) return result
        return Promise.resolve(result as Promise<APIResponse>).then(async (response) => {
          await onResponse(response, method, prepared?.attemptId)
          return response
        })
      }
    },
  })
}

export async function guardBrowserMutations(
  context: BrowserContext,
  mutations: boolean,
  prepareRequest?: (request: import('@playwright/test').Request) => PreparedPaperRequest,
): Promise<string[]> {
  const blocked: string[] = []
  await context.route('**/api/v1/ibkr/**', async (route) => {
    const request = route.request()
    if (!mutations && isBrokerMutation(request.method(), request.url())) {
      blocked.push(`${request.method()} ${new URL(request.url()).pathname}`)
      await route.abort('blockedbyclient')
    } else {
      const prepared = prepareRequest?.(request)
      await route.fallback(
        prepared?.attemptId ? { postData: JSON.stringify(prepared.body) } : undefined,
      )
    }
  })
  return blocked
}
