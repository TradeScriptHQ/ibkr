import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { APIRequestContext, BrowserContext, Response } from '@playwright/test'
import { trackPaperOrders } from './paper-order-tracker.js'

// Minimal transport doubles exercise ownership and teardown without broker connectivity.
for (const path of ['/api/v1/ibkr/orders', '/api/v1/ibkr/positions/owned-position/close']) {
  test(`fixture cleanup retains ${path} receipts and leaves unrelated orders untouched`, async () => {
    const context = new EventEmitter()
    const tracker = trackPaperOrders(context as unknown as BrowserContext, true)
    let orders = [
      { id: 'test-parent' },
      { id: 'test-child', parentId: 'test-parent' },
      { id: 'user-order' },
    ]
    const cancelled: string[] = []
    const response = (body: unknown) => ({
      status: () => 200,
      url: () => 'http://localhost/api/v1/ibkr/state',
      headers: () => ({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
      json: async () => body,
    })
    const probe = {
      get: async () => response({ orders }),
      delete: async (url: string) => {
        const id = url.split('/').at(-1) ?? ''
        cancelled.push(id)
        orders = orders.filter((order) => order.id !== id)
        return response({})
      },
    } as unknown as APIRequestContext
    const receipt = {
      status: () => 201,
      url: () => `http://localhost${path}`,
      request: () => ({ method: () => 'POST' }),
      json: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { order: { id: 'test-parent' } }
      },
    } as unknown as Response
    try {
      context.emit('response', receipt)
      await tracker.cleanup(probe, { csrfToken: 'test', expiresAt: '', mutationHeaders: {} })
      assert.deepEqual(cancelled, ['test-parent', 'test-child'])
      assert.deepEqual(orders, [{ id: 'user-order' }])
    } finally {
      tracker.dispose()
    }
    assert.equal(context.listenerCount('response'), 0)
  })
}
