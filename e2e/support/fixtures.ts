import { test as base, expect, request as playwrightRequest } from '@playwright/test'
import { guardBrokerRequests, guardBrowserMutations } from './broker-guards.js'
import { trackPaperOrders } from './paper-order-tracker.js'
import { openTerminalSession, TERMINAL_ORIGIN } from './session.js'

export { expect }

/** Every real-broker spec uses this fixture, including direct Playwright invocations. */
export const test = base.extend<{
  paperConnection: undefined
  paperOrders: ReturnType<typeof trackPaperOrders>
}>({
  paperOrders: async ({ context }, use, testInfo) => {
    const orders = trackPaperOrders(context, testInfo.tags.includes('@paper'))
    try {
      await use(orders)
    } finally {
      orders.dispose()
    }
  },
  request: async ({ request, paperOrders }, use, testInfo) => {
    await use(
      guardBrokerRequests(
        request,
        testInfo.tags.includes('@paper'),
        paperOrders.recordResponse,
        paperOrders.prepareRequest,
      ),
    )
  },
  paperConnection: [
    async ({ baseURL, context, paperOrders }, use, testInfo) => {
      const mutations = testInfo.tags.includes('@paper')
      const blocked = await guardBrowserMutations(
        context,
        mutations,
        paperOrders.prepareBrowserRequest,
      )
      // Separate cookies keep authentication tests independent of the paper preflight.
      const probe = await playwrightRequest.newContext({ baseURL: baseURL ?? TERMINAL_ORIGIN })
      try {
        const session = await openTerminalSession(probe)
        try {
          await use(undefined)
        } finally {
          const cleanupSession = mutations ? await openTerminalSession(probe) : session
          await paperOrders.cleanup(probe, cleanupSession)
          expect(blocked, 'A read-only test attempted a broker mutation').toEqual([])
        }
      } finally {
        await probe.dispose()
      }
    },
    // Initial cancellation (30s), owned recovery (60s), failure cancellation (30s), plus preflight margin.
    { auto: true, timeout: 150_000 },
  ],
})
