import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { APIRequestContext } from '@playwright/test'
import { guardBrokerRequests } from './broker-guards.js'

test('request guard blocks direct and generic writes before reaching the underlying client', async () => {
  const calls: string[] = []
  const client = {
    async get() {
      calls.push('read')
    },
    async post() {
      calls.push('post')
    },
    async fetch() {
      calls.push('fetch')
    },
  } as unknown as APIRequestContext
  const guarded = guardBrokerRequests(client, false)
  assert.throws(() => guarded.post('/api/v1/ibkr/orders'), /Read-only E2E blocked POST/)
  assert.throws(
    () => guarded.fetch('/api/v1/ibkr/orders/42', { method: 'DELETE' }),
    /blocked DELETE/,
  )
  assert.deepEqual(calls, [])
  await guarded.get('/api/v1/ibkr/state')
  await guarded.post('/api/v1/ibkr/orders/preview')
  await guardBrokerRequests(client, true).post('/api/v1/ibkr/orders')
  assert.deepEqual(calls, ['read', 'post', 'post'])
})
