import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/persistence/database.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('durable local ledger', () => {
  it('creates owner-only storage and detects operation conflicts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ibkr-terminal-db-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'state', 'terminal.sqlite')
    const database = new LocalDatabase(path)

    if (process.platform !== 'win32') {
      expect(statSync(join(directory, 'state')).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(
      database.registerOperation({
        attachmentId: 'human:local',
        operationId: 'operation-1',
        intentFingerprint: 'fingerprint-a',
      }),
    ).toEqual({ status: 'registered' })
    expect(
      database.registerOperation({
        attachmentId: 'human:local',
        operationId: 'operation-1',
        intentFingerprint: 'fingerprint-a',
      }),
    ).toMatchObject({ status: 'duplicate', state: 'received' })
    expect(
      database.registerOperation({
        attachmentId: 'human:local',
        operationId: 'operation-1',
        intentFingerprint: 'fingerprint-b',
      }),
    ).toEqual({ status: 'conflict' })

    database.close()
  })
})
