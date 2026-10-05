import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveTerminalE2EOrigin } from './terminal-origin.js'

const invalidOrigin = /TERMINAL_E2E_ORIGIN must be a canonical http:\/\/localhost:<port> origin/u

test('E2E origin keeps the standard workstation when no explicit origin is supplied', () => {
  assert.equal(resolveTerminalE2EOrigin(undefined), 'http://localhost:3000')
})

test('E2E origin accepts explicit canonical localhost ports for an isolated workstation', () => {
  assert.equal(resolveTerminalE2EOrigin('http://localhost:3002'), 'http://localhost:3002')
  assert.equal(resolveTerminalE2EOrigin('http://localhost:65535'), 'http://localhost:65535')
})

test('E2E origin rejects credentials without including the rejected input in its error', () => {
  for (const value of [
    'http://fixture:placeholder@localhost:3002',
    'http://fixture@localhost:3002',
  ])
    assert.throws(
      () => resolveTerminalE2EOrigin(value),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, invalidOrigin)
        assert.ok(!error.message.includes('fixture'))
        assert.ok(!error.message.includes('placeholder'))
        return true
      },
    )
})

test('E2E origin refuses every host outside the explicit localhost scope', () => {
  for (const value of [
    'http://example.com:3002',
    'http://localhost.example.com:3002',
    'http://localhost.:3002',
    'http://127.0.0.1:3002',
    'http://[::1]:3002',
    'http://loc%61lhost:3002',
  ])
    assert.throws(() => resolveTerminalE2EOrigin(value), invalidOrigin)
})

test('E2E origin rejects paths, queries and fragments including empty suffixes', () => {
  for (const value of [
    'http://localhost:3002/',
    'http://localhost:3002/terminal',
    'http://localhost:3002/..',
    'http://localhost:3002?mode=paper',
    'http://localhost:3002?',
    'http://localhost:3002#terminal',
    'http://localhost:3002#',
  ])
    assert.throws(() => resolveTerminalE2EOrigin(value), invalidOrigin)
})

test('E2E origin rejects unsafe schemes, invalid ports and noncanonical settings', () => {
  for (const value of [
    'https://localhost:3002',
    'file://localhost:3002',
    'http://localhost',
    'http://localhost:0',
    'http://localhost:65536',
    'http://localhost:80',
    'http://localhost:03002',
    'HTTP://LOCALHOST:3002',
    ' http://localhost:3002',
    '',
    'not-an-origin',
  ])
    assert.throws(() => resolveTerminalE2EOrigin(value), invalidOrigin)
})

function configuredImport(origin: string, script: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, TERMINAL_E2E_ORIGIN: origin },
    encoding: 'utf8',
    timeout: 10_000,
  })
}

test('one explicit E2E origin binds Playwright requests and session headers to the same workstation', () => {
  const result = configuredImport(
    'http://localhost:3002',
    `import config from './playwright.config.ts'
import { browserHeaders, TERMINAL_ORIGIN } from './e2e/support/session.ts'
const expected = 'http://localhost:3002'
console.log(JSON.stringify({
  session: TERMINAL_ORIGIN === expected,
  headers: browserHeaders.origin === expected,
  baseURL: config.use?.baseURL === expected,
}))`,
  )
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), { session: true, headers: true, baseURL: true })
})

test('an unsafe explicit origin fails before the Playwright configuration can be used', () => {
  const result = configuredImport(
    'https://example.com:3002',
    "await import('./playwright.config.ts')",
  )
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, invalidOrigin)
  assert.equal(result.stdout, '')
})
