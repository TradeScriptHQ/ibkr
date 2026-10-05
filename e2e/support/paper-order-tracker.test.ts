import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { APIRequestContext, APIResponse, BrowserContext, Response } from '@playwright/test'
import { guardBrokerRequests } from './broker-guards.js'
import { trackPaperOrders } from './paper-order-tracker.js'

const order = (id: string, parentId?: string) => ({
  id,
  ...(parentId ? { parentId } : {}),
  accountId: 'paper-test',
  symbol: { symbol: 'AAPL', assetClass: 'stock', currency: 'USD' },
  quantity: 1,
  filledQuantity: 0,
  remainingQuantity: 1,
  side: 'buy',
  type: 'limit',
  duration: 'day',
  status: 'working',
  submittedAt: '2026-09-30T12:00:00Z',
  updatedAt: '2026-09-30T12:00:00Z',
  customFields: {} as Record<string, unknown>,
})
// Minimal transport doubles exercise ownership and teardown without broker connectivity.
for (const path of ['/api/v1/ibkr/orders', '/api/v1/ibkr/positions/owned-position/close']) {
  test(`fixture cleanup retains ${path} receipts and leaves unrelated orders untouched`, async () => {
    const context = new EventEmitter()
    const tracker = trackPaperOrders(context as unknown as BrowserContext, true)
    let orders = [order('test-parent'), order('test-child', 'test-parent'), order('user-order')]
    const history: typeof orders = []
    const cancelled: string[] = []
    const response = (body: unknown) => ({
      status: () => 200,
      url: () => 'http://localhost/api/v1/ibkr/state',
      headers: () => ({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
      json: async () => body,
    })
    const probe = {
      get: async () => response({ orders, ordersHistory: history }),
      delete: async (url: string) => {
        const id = url.split('/').at(-1) ?? ''
        cancelled.push(id)
        history.push({ ...orders.find((order) => order.id === id)!, status: 'cancelled' })
        orders = orders.filter((order) => order.id !== id)
        return response({})
      },
    } as unknown as APIRequestContext
    const transportRequest = {
      method: () => 'POST',
      url: () => `http://localhost${path}`,
      postDataJSON: () => ({ expectedExecutionEnvironment: 'paper', draft: orders[0] }),
      headers: () => ({}),
    }
    const prepared = tracker.prepareBrowserRequest(
      transportRequest as unknown as import('@playwright/test').Request,
    )
    if (path.endsWith('/orders'))
      orders[0]!.customFields = (
        prepared.body as { draft: { customFields: Record<string, unknown> } }
      ).draft.customFields
    else
      orders[0]!.customFields = {
        paperE2EOwner: (prepared.body as { options: { paperOwnershipId: string } }).options
          .paperOwnershipId,
      }
    const receipt = {
      status: () => 201,
      url: () => `http://localhost${path}`,
      request: () => transportRequest,
      json: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { order: orders[0] }
      },
    } as unknown as Response
    try {
      context.emit('response', receipt)
      await tracker.cleanup(probe, { csrfToken: 'test', expiresAt: '', mutationHeaders: {} })
      assert.deepEqual(cancelled, ['test-parent', 'test-child'])
      assert.deepEqual(orders, [order('user-order')])
    } finally {
      tracker.dispose()
    }
    assert.equal(context.listenerCount('response'), 0)
  })
}

test('direct API receipts are recorded before a failing caller assertion and cleaned by exact ownership', async () => {
  const context = new EventEmitter()
  const tracker = trackPaperOrders(context as unknown as BrowserContext, true)
  let registered = false
  let orders = [order('api-parent'), order('api-child', 'api-parent'), order('user-order')]
  const history: typeof orders = []
  const response = (body: unknown, status = 200, url = 'http://localhost/api/v1/ibkr/state') =>
    ({
      status: () => status,
      url: () => url,
      headers: () => ({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
      json: async () => body,
    }) as unknown as APIResponse
  const client = {
    post: async (
      _url: string,
      options: { data: { draft: { customFields: Record<string, unknown> } } },
    ) => {
      orders[0]!.customFields = options.data.draft.customFields
      return {
        ...response({}, 201, 'http://localhost/api/v1/ibkr/orders'),
        json: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          registered = true
          return { order: orders[0] }
        },
      }
    },
  } as unknown as APIRequestContext
  const guarded = guardBrokerRequests(client, true, tracker.recordResponse, tracker.prepareRequest)
  const cancelled: string[] = []
  const probe = {
    get: async () => response({ orders, ordersHistory: history }),
    delete: async (url: string) => {
      const id = url.split('/').at(-1) ?? ''
      cancelled.push(id)
      history.push({ ...orders.find((order) => order.id === id)!, status: 'cancelled' })
      orders = orders.filter((order) => order.id !== id)
      return response({})
    },
  } as unknown as APIRequestContext
  try {
    await guarded.post('/api/v1/ibkr/orders', {
      data: { draft: orders[0], expectedExecutionEnvironment: 'paper' },
    })
    assert.equal(registered, true)
    // Teardown owns the receipt even if the test stops immediately after this return.
    await tracker.cleanup(probe, { csrfToken: 'test', expiresAt: '', mutationHeaders: {} })
    assert.deepEqual(cancelled, ['api-parent', 'api-child'])
    assert.deepEqual(orders, [order('user-order')])
  } finally {
    tracker.dispose()
  }
})

test('an invalid direct placement receipt fails both registration and teardown', async () => {
  const context = new EventEmitter()
  const tracker = trackPaperOrders(context as unknown as BrowserContext, true)
  const receipt = {
    status: () => 201,
    url: () => 'http://localhost/api/v1/ibkr/orders',
    json: async () => ({ order: {} }),
  } as unknown as APIResponse
  try {
    await assert.rejects(tracker.recordResponse(receipt, 'POST'), /no usable order receipt/)
    await assert.rejects(
      tracker.cleanup({} as APIRequestContext, {
        csrfToken: 'test',
        expiresAt: '',
        mutationHeaders: {},
      }),
    )
  } finally {
    tracker.dispose()
  }
})
