import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requireKnownSessionState } from './paper-session.js'

test('failed, missing and unknown market sessions cannot become execution skips', () => {
  for (const response of [
    undefined,
    null,
    {},
    { error: 'unavailable' },
    { currentState: 'unknown' },
    { currentState: 'invented' },
  ]) {
    assert.throws(() => requireKnownSessionState(response), /no known market-session state/)
  }
  assert.equal(requireKnownSessionState({ currentState: 'regular' }), 'regular')
  assert.equal(requireKnownSessionState({ currentState: 'closed' }), 'closed')
})
