import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { prepareDevelopmentBundle } from './dev-runner.mjs'

const execute = promisify(execFile)
const runnerModule = new URL('./dev-runner.mjs', import.meta.url).href
const configUrl = new URL('../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url)
const macOSOnly = { skip: process.platform !== 'darwin' }

async function waitForFile(file, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Fixture did not write ${path.basename(file)}`)
}

async function lifecycleFixture(directory) {
  const native = path.join(directory, 'native.mjs')
  const started = path.join(directory, 'native-started')
  const stopped = path.join(directory, 'native-stopped')
  const completed = path.join(directory, 'runner-completed')
  const runner = path.join(directory, 'runner.mjs')
  await writeFile(
    native,
    `
import { writeFileSync } from 'node:fs'
writeFileSync(process.argv[2], String(process.pid))
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    writeFileSync(process.argv[3], signal)
    process.exit(0)
  })
}
setInterval(() => {}, 100)
`,
  )
  await writeFile(
    runner,
    `
import { writeFile } from 'node:fs/promises'
import { runDevelopmentExecutable } from ${JSON.stringify(runnerModule)}
process.exitCode = await runDevelopmentExecutable(process.execPath, ${JSON.stringify([native, started, stopped])})
await writeFile(${JSON.stringify(completed)}, String(process.exitCode))
`,
  )
  return { native, started, stopped, completed, runner }
}

test(
  'macOS development bundle uses real metadata and contains only native files',
  macOSOnly,
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'desktop runner packaging '))
    try {
      const source = path.join(directory, 'tradescript-terminal')
      await writeFile(source, '#!/bin/sh\nexit 0\n')
      const config = JSON.parse(await readFile(configUrl, 'utf8'))
      assert.equal(config.productName, 'IBKR Tradescript Terminal')
      const { bundle, executable } = await prepareDevelopmentBundle(source, {
        outputDirectory: path.join(directory, 'app output with spaces'),
      })
      assert.equal(path.basename(bundle), `${config.productName} Dev.app`)
      const { stdout } = await execute('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        path.join(bundle, 'Contents/Info.plist'),
      ])
      const metadata = JSON.parse(stdout)
      assert.equal(metadata.CFBundleIdentifier, `${config.identifier}.development`)
      assert.equal(metadata.CFBundleIdentifier, 'dev.tradescript.ibkr-terminal.development')
      assert.equal(metadata.CFBundleExecutable, 'tradescript-terminal')
      assert.equal(metadata.CFBundleName, `${config.productName} Dev`)
      assert.equal(metadata.CFBundleDisplayName, `${config.productName} Dev`)
      assert.equal(metadata.CFBundleVersion, config.version)
      assert.equal(metadata.LSMinimumSystemVersion, config.bundle.macOS.minimumSystemVersion)
      assert.equal(metadata.NSHighResolutionCapable, true)
      assert.equal(metadata.CFBundleURLTypes, undefined)
      assert.deepEqual((await readdir(path.join(bundle, 'Contents'))).sort(), [
        'Info.plist',
        'MacOS',
        'Resources',
      ])
      assert.deepEqual(await readdir(path.join(bundle, 'Contents/Resources')), ['icon.icns'])
      assert.deepEqual(await readdir(path.dirname(executable)), ['tradescript-terminal'])
      assert.equal((await stat(executable)).mode & 0o777, 0o755)
      assert.equal(await readFile(executable, 'utf8'), await readFile(source, 'utf8'))
      await writeFile(source, '#!/bin/sh\nexit 7\n')
      await prepareDevelopmentBundle(source, { outputDirectory: path.dirname(bundle) })
      assert.equal(await readFile(executable, 'utf8'), await readFile(source, 'utf8'))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test('runner forwards termination and waits for its own native child', macOSOnly, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'desktop-runner-signal-'))
  let runner
  try {
    const fixture = await lifecycleFixture(directory)
    runner = spawn(process.execPath, [fixture.runner], { stdio: 'ignore' })
    const finished = new Promise((resolve, reject) => {
      runner.once('error', reject)
      runner.once('close', (code, signal) => resolve({ code, signal }))
    })
    await waitForFile(fixture.started)
    runner.kill('SIGTERM')
    assert.deepEqual(await finished, { code: 0, signal: null })
    assert.equal(await readFile(fixture.stopped, 'utf8'), 'SIGTERM')
    assert.equal(await readFile(fixture.completed, 'utf8'), '0')
  } finally {
    if (runner?.exitCode === null && runner?.signalCode === null) runner.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
})

test('runner cleans up its native child when its Cargo-like parent exits', macOSOnly, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'desktop-runner-parent-'))
  try {
    const fixture = await lifecycleFixture(directory)
    const parent = path.join(directory, 'parent.mjs')
    await writeFile(
      parent,
      `
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
const runner = spawn(process.execPath, [${JSON.stringify(fixture.runner)}], { stdio: 'ignore' })
runner.unref()
while (true) {
  try { await access(${JSON.stringify(fixture.started)}); break } catch {}
  await new Promise(resolve => setTimeout(resolve, 20))
}
process.exit(0)
`,
    )
    await execute(process.execPath, [parent], { timeout: 5_000 })
    assert.equal(await waitForFile(fixture.stopped), 'SIGTERM')
    assert.equal(await waitForFile(fixture.completed), '0')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
