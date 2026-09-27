import { test as base, expect, request as playwrightRequest } from '@playwright/test'
import { guardBrokerRequests, guardBrowserMutations } from './broker-guards.js'
import { trackPaperOrders } from './paper-order-tracker.js'
import { openTerminalSession, TERMINAL_ORIGIN } from './session.js'

export { expect }

/** Every real-broker spec uses this fixture, including direct Playwright invocations. */
export const test = base.extend<{ paperConnection: undefined }>({
  request: async ({ request }, use, testInfo) => {
    await use(guardBrokerRequests(request, testInfo.tags.includes('@paper')))
  },
  paperConnection: [
    async ({ baseURL, context }, use, testInfo) => {
      const mutations = testInfo.tags.includes('@paper')
      const blocked = await guardBrowserMutations(context, mutations)
      const orders = trackPaperOrders(context, mutations)
      // Separate cookies keep authentication tests independent of the paper preflight.
      const probe = await playwrightRequest.newContext({ baseURL: baseURL ?? TERMINAL_ORIGIN })
      try {
        const session = await openTerminalSession(probe)
        try {
          await use(undefined)
        } finally {
          await orders.cleanup(probe, session)
          expect(blocked, 'A read-only test attempted a broker mutation').toEqual([])
        }
      } finally {
        orders.dispose()
        await probe.dispose()
      }
    },
    { auto: true, timeout: 90_000 },
  ],
})
