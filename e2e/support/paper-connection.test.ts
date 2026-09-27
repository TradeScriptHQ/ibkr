import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectionSnapshot } from '@ibkr-terminal/contracts'
import { assertPaperConnection } from './paper-connection.js'

const connection: ConnectionSnapshot = {
  generation: 'test',
  settings: {
    active: 'paper',
    profiles: {
      paper: { port: 7497, clientId: 1, permission: 'manual', allowedAccountIds: ['DU-TEST'] },
      live: { port: 7496, clientId: 1, permission: 'read-only', allowedAccountIds: [] },
    },
  },
}
const state = { connectionStatus: 'connected' as const, activeAccountId: 'DU-TEST' }

test('paper execution needs no confirmation flag when the connected account is paper and allowlisted', () => {
  assert.doesNotThrow(() => assertPaperConnection(connection, state))
})

test('paper E2E refuses live mode even when a paper account is reported', () => {
  assert.throws(
    () =>
      assertPaperConnection(
        {
          ...connection,
          settings: { ...connection.settings, active: 'live' },
        },
        state,
      ),
    /requires paper mode/,
  )
})

test('paper E2E refuses standard live ports even when configured as a paper profile', () => {
  for (const port of [7496, 4001]) {
    const changed = structuredClone(connection)
    changed.settings.profiles.paper.port = port
    assert.throws(() => assertPaperConnection(changed, state), /refuses a live/)
  }
})

test('paper E2E refuses disconnected, non-paper, and unallowlisted accounts', () => {
  assert.throws(
    () => assertPaperConnection(connection, { ...state, connectionStatus: 'disconnected' }),
    /requires connected/,
  )
  assert.throws(
    () => assertPaperConnection(connection, { ...state, activeAccountId: 'U-TEST' }),
    /requires a paper account/,
  )
  assert.throws(
    () => assertPaperConnection(connection, { ...state, activeAccountId: 'DU-OTHER' }),
    /must be allowlisted/,
  )
})
