import type { APIRequestContext, BrowserContext, Response } from '@playwright/test'
import { expect } from '@playwright/test'
import { ownsOrder } from './order-safety.js'
import { expectJsonOk, pollBrokerState, readBrokerState, type TerminalSession } from './session.js'

/** Register receipts before assertions can fail; only those orders and their children are owned. */
export function trackPaperOrders(context: BrowserContext, mutations: boolean) {
  const ownedIds = new Set<string>()
  const receipts: Promise<void>[] = []
  const onResponse = (response: Response) => {
    if (
      mutations &&
      response.status() === 201 &&
      response.request().method() === 'POST' &&
      (new URL(response.url()).pathname === '/api/v1/ibkr/orders' ||
        /^\/api\/v1\/ibkr\/positions\/[^/]+\/close$/u.test(new URL(response.url()).pathname))
    ) {
      // Register ownership before test assertions can fail or a test can time out.
      receipts.push(
        response.json().then((body) => {
          if (typeof body.order?.id !== 'string' || !body.order.id)
            throw new Error('Paper placement returned no usable order receipt')
          ownedIds.add(body.order.id)
        }),
      )
    }
  }
  context.on('response', onResponse)

  return {
    async cleanup(probe: APIRequestContext, session: TerminalSession): Promise<void> {
      const receiptResults = await Promise.allSettled(receipts)
      if (ownedIds.size > 0) {
        const state = await readBrokerState(probe)
        for (const order of state.orders.filter((order) => ownsOrder(order, ownedIds))) {
          const current = await readBrokerState(probe)
          if (!current.orders.some((candidate) => candidate.id === order.id)) continue
          await expectJsonOk(
            await probe.delete(`/api/v1/ibkr/orders/${encodeURIComponent(order.id)}`, {
              headers: session.mutationHeaders,
              data: { expectedExecutionEnvironment: 'paper' },
            }),
          )
        }
        await pollBrokerState(
          probe,
          (state) => (state.orders.some((order) => ownsOrder(order, ownedIds)) ? undefined : true),
          30_000,
        )
      }
      expect(
        receiptResults.every((result) => result.status === 'fulfilled'),
        'Every paper placement must retain its cleanup receipt',
      ).toBe(true)
    },
    dispose() {
      context.off('response', onResponse)
    },
  }
}
