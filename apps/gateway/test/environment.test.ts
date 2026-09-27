import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRootEnvironment } from '../src/environment.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ibkr-terminal-env-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('.env loader', () => {
  it('loads an owner-only regular file without mutating process.env', () => {
    const path = join(temporaryDirectory(), '.env')
    writeFileSync(path, 'IBKR_PORT=7497\n', { mode: 0o600 })
    const loaded = loadRootEnvironment({ SENTINEL: 'kept' }, path)
    expect(loaded).toMatchObject({ SENTINEL: 'kept', IBKR_PORT: '7497' })
    expect(process.env.IBKR_PORT).toBeUndefined()
  })

  it('rejects duplicate keys', () => {
    const path = join(temporaryDirectory(), '.env')
    writeFileSync(path, 'IBKR_PORT=7497\nIBKR_PORT=7496\n', { mode: 0o600 })
    expect(() => loadRootEnvironment({}, path)).toThrow(/Duplicate key/u)
  })

  it.skipIf(process.platform === 'win32')('rejects permissive file modes', () => {
    const path = join(temporaryDirectory(), '.env')
    writeFileSync(path, 'IBKR_PORT=7497\n', { mode: 0o600 })
    chmodSync(path, 0o644)
    expect(() => loadRootEnvironment({}, path)).toThrow(/mode 0600/u)
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links', () => {
    const directory = temporaryDirectory()
    const target = join(directory, 'target')
    const link = join(directory, '.env')
    writeFileSync(target, 'IBKR_PORT=7497\n', { mode: 0o600 })
    symlinkSync(target, link)
    expect(() => loadRootEnvironment({}, link)).toThrow(/cannot be a symbolic link/u)
  })
})
