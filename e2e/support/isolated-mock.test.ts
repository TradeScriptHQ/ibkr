import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { loadRootEnvironment } from '../../apps/gateway/src/environment.js'
import { isolatedMockEnvironment, unusedPort } from '../../scripts/isolated-mock.js'

test('isolated mock startup carries only SDK settings, uses its own ports/state, and cleans up', async () => {
  const uiPort = await unusedPort()
  const isolated = await isolatedMockEnvironment(uiPort, {
    IBKR_EXECUTION_ENVIRONMENT: 'live',
    IBKR_ALLOWED_ACCOUNT_IDS: 'must-not-copy',
    TERMINAL_DATA_DIR: '/must-not-use',
    TRADESCRIPT_NPM_TOKEN: 'must-not-copy',
    TRADESCRIPT_CREDENTIAL_ID: 'fixture-id',
    TRADESCRIPT_CREDENTIAL_SECRET: 'fixture-secret',
  })
  const path = isolated.environment.TERMINAL_ENV_FILE!
  try {
    const loaded = loadRootEnvironment({}, path)
    assert.equal(loaded.IBKR_EXECUTION_ENVIRONMENT, 'paper')
    assert.equal(loaded.IBKR_ALLOWED_ACCOUNT_IDS, '')
    assert.equal(loaded.TRADESCRIPT_NPM_TOKEN, undefined)
    assert.equal(loaded.VITE_TRADING_MODE, 'mock')
    assert.equal(loaded.UI_ORIGIN, `http://localhost:${uiPort}`)
    assert.equal(loaded.TRADESCRIPT_REQUESTED_ORIGIN, loaded.UI_ORIGIN)
    assert.equal(loaded.TRADESCRIPT_CREDENTIAL_ID, 'fixture-id')
    // Windows emulates POSIX modes; the 0600 guarantee is enforced on macOS and Linux only.
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
    // Compare resolved paths so Windows separators and .env quoting cannot change the result.
    assert.equal(resolve(loaded.TERMINAL_DATA_DIR ?? ''), resolve(dirname(path), 'state'))
    const ports = [
      'UI_PORT',
      'GATEWAY_PORT',
      'TRADESCRIPT_MCP_HTTP_PORT',
      'TRADESCRIPT_MCP_BRIDGE_PORT',
    ].map((key) => loaded[key])
    assert.equal(new Set(ports).size, 4)
  } finally {
    isolated.cleanup()
  }
  assert.equal(existsSync(dirname(path)), false)
})
