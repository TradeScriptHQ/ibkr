import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isBrokerMutation, ownsOrder } from './order-safety.js'

test('guards all order and position writes while permitting broker previews and reads', () => {
  for (const [method, path] of [
    ['POST', '/orders'],
    ['PATCH', '/orders/42'],
    ['DELETE', '/orders/42'],
    ['POST', '/orders/cancel-all'],
    ['POST', '/positions/42/close'],
    ['POST', '/orders/?unexpected=preview'],
  ])
    assert.equal(isBrokerMutation(method!, `/api/v1/ibkr${path}`), true)
  for (const [method, path] of [
    ['GET', '/orders'],
    ['POST', '/orders/preview'],
    ['POST', '/orders/42/preview'],
    ['POST', '/options/resolve'],
    ['POST', '/positions/42/preview'],
  ])
    assert.equal(isBrokerMutation(method!, `/api/v1/ibkr${path}`), false)
})

test('cleanup owns only registered orders and their linked children, never all newly seen orders', () => {
  const ids = new Set(['test-parent'])
  assert.equal(ownsOrder({ id: 'test-parent' }, ids), true)
  assert.equal(ownsOrder({ id: 'test-child', parentId: 'test-parent' }, ids), true)
  assert.equal(ownsOrder({ id: 'test-child', bracketGroupId: 'test-parent' }, ids), true)
  assert.equal(ownsOrder({ id: 'new-user-order' }, ids), false)
  assert.equal(ownsOrder({ id: 'user-child', parentId: 'new-user-order' }, ids), false)
})
