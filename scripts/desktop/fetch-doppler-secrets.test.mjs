import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DESKTOP_DOPPLER_PROJECT,
  expectedResponseNames,
  selectedSecretNames,
} from './doppler-secret-contract.mjs'
import {
  fetchDesktopSecrets,
  parseDopplerResponse,
  selectSecrets,
  writeSecretFile,
} from './fetch-doppler-secrets.mjs'

function response(overrides = {}, identity = {}) {
  const values = {
    TRADESCRIPT_NPM_TOKEN: 'npm-token-value',
    TAURI_SIGNING_PRIVATE_KEY: 'private-key-value',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'private-key-password',
    DOPPLER_PROJECT: DESKTOP_DOPPLER_PROJECT,
    DOPPLER_CONFIG: 'prd',
    DOPPLER_ENVIRONMENT: 'prd',
    ...identity,
  }
  return {
    success: true,
    secrets: Object.fromEntries(
      Object.entries({ ...values, ...overrides }).map(([name, value]) => [
        name,
        { computed: value },
      ]),
    ),
  }
}

test('the desktop selection covers the release boundaries exactly', () => {
  assert.deepEqual(selectedSecretNames(), [
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'TRADESCRIPT_NPM_TOKEN',
  ])
  assert.deepEqual(expectedResponseNames(), [
    'DOPPLER_CONFIG',
    'DOPPLER_ENVIRONMENT',
    'DOPPLER_PROJECT',
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'TRADESCRIPT_NPM_TOKEN',
  ])
})

test('a valid Doppler response is parsed and split by release boundary', () => {
  const secrets = selectSecrets(parseDopplerResponse(response()))
  assert.deepEqual(secrets.npm, { TRADESCRIPT_NPM_TOKEN: 'npm-token-value' })
  assert.deepEqual(secrets.signing, {
    TAURI_SIGNING_PRIVATE_KEY: 'private-key-value',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'private-key-password',
  })
})

test('invalid responses and unexpected secrets are rejected', () => {
  assert.throws(() => parseDopplerResponse({ success: false }))
  assert.throws(() => parseDopplerResponse({ success: true, secrets: { A: {} } }))
  assert.throws(() => selectSecrets(parseDopplerResponse(response({ UNREVIEWED_SECRET: 'value' }))))
  assert.throws(() =>
    selectSecrets(parseDopplerResponse(response({}, { DOPPLER_PROJECT: 'other' }))),
  )
  const missing = response()
  delete missing.secrets.TAURI_SIGNING_PRIVATE_KEY
  assert.throws(() => selectSecrets(parseDopplerResponse(missing)))
})

test('fetch rejects a missing token before contacting the network', async () => {
  await assert.rejects(fetchDesktopSecrets({ token: '' }))
})

test('written secret files are owner-only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desktop-doppler-'))
  try {
    const file = path.join(dir, 'secrets.json')
    await writeSecretFile(file, { npm: { TRADESCRIPT_NPM_TOKEN: 'value' } })
    const facts = await stat(file)
    // Windows emulates POSIX modes; the owner-only guarantee applies to macOS and Linux.
    if (process.platform !== 'win32') assert.equal(facts.mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      npm: { TRADESCRIPT_NPM_TOKEN: 'value' },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
