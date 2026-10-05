import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('signing secrets reach only the final packaging child and the fetch token is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-signing-boundary-'))
  try {
    const harness = join(directory, 'harness.mjs')
    await writeFile(
      harness,
      `
      import assert from 'node:assert/strict'
      import childProcess from 'node:child_process'
      import { EventEmitter } from 'node:events'
      import { syncBuiltinESMExports } from 'node:module'
      const signing = {
        TAURI_SIGNING_PRIVATE_KEY: 'dummy-key%with\\nnewline',
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'dummy-password',
      }
      globalThis.fetch = async (_url, options) => {
        assert.equal(options.headers.authorization, 'Bearer dummy-fetch-token')
        assert.equal(process.env.TAURI_SIGNING_PRIVATE_KEY, undefined)
        assert.equal(process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined)
        return {
          ok: true,
          json: async () => ({ success: true, secrets: Object.fromEntries(
            Object.entries({ ...signing, TRADESCRIPT_NPM_TOKEN: 'dummy-registry-token',
              DOPPLER_PROJECT: 'ibkr', DOPPLER_CONFIG: 'prd', DOPPLER_ENVIRONMENT: 'prd' })
              .map(([name, computed]) => [name, { computed }])
          ) }),
        }
      }
      childProcess.spawn = (command, args, options) => {
        assert.equal(command, 'npm')
        assert.deepEqual(args, ['run', 'build', '--workspace=@ibkr-terminal/desktop', '--', '--bundles', 'dmg'])
        assert.equal(options.env.DOPPLER_TOKEN, undefined)
        assert.equal(options.env.SENTINEL, 'preserved')
        assert.equal(options.env.TAURI_SIGNING_PRIVATE_KEY, signing.TAURI_SIGNING_PRIVATE_KEY)
        assert.equal(options.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, signing.TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
        assert.equal(process.env.TAURI_SIGNING_PRIVATE_KEY, undefined)
        assert.equal(process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined)
        const child = new EventEmitter()
        queueMicrotask(() => child.emit('exit', 7))
        return child
      }
      syncBuiltinESMExports()
      process.argv = [process.execPath, ${JSON.stringify(new URL('./sign-release.mjs', import.meta.url).pathname)}, '--bundles', 'dmg']
      await import(${JSON.stringify(new URL('./sign-release.mjs', import.meta.url).href)})
    `,
    )
    const result = spawnSync(process.execPath, [harness], {
      env: { PATH: process.env.PATH, DOPPLER_TOKEN: 'dummy-fetch-token', SENTINEL: 'preserved' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 7, result.stderr)
    assert.equal(result.signal, null)
    assert.match(result.stdout, /::add-mask::dummy-key%25with%0Anewline/u)
    assert.match(result.stdout, /::add-mask::dummy-password/u)
    assert.doesNotMatch(result.stdout, /dummy-fetch-token/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release workflow exports only registry credentials before checks and scopes signing fetch to packaging', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/desktop-release.yml', import.meta.url),
    'utf8',
  )
  const beforePackaging = workflow.split('      - name: Build installers and signed updates')[0]
  assert.ok(beforePackaging)
  const environmentExport = beforePackaging
    .split('\n')
    .find((line) => line.includes('>> "$GITHUB_ENV"'))
  assert.ok(environmentExport)
  assert.match(environmentExport, /'\.npm \|/u)
  assert.doesNotMatch(environmentExport, /signing/u)
  assert.doesNotMatch(beforePackaging, /TAURI_SIGNING_PRIVATE_KEY/u)
  assert.match(
    workflow,
    /name: Build installers and signed updates\n {8}env:\n {10}DOPPLER_TOKEN:/u,
  )
  assert.match(workflow, /run: node scripts\/desktop\/sign-release\.mjs --config/u)
})
