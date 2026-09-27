import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface JournalRecord {
  readonly category: string
  readonly eventType: string
  readonly actorType: 'human' | 'agent' | 'host' | 'broker'
  readonly correlationId?: string
  readonly payload: Readonly<Record<string, unknown>>
}

export type OperationRegistration =
  | { readonly status: 'registered' }
  | { readonly status: 'duplicate'; readonly state: string; readonly receiptJson?: string }
  | { readonly status: 'conflict' }

export class LocalDatabase {
  readonly #database: DatabaseSync
  readonly #path: string

  constructor(path: string) {
    this.#path = path
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    this.#database = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `)
    this.#migrate()
    const quickCheck = this.#database.prepare('PRAGMA quick_check').get() as
      | { quick_check: string }
      | undefined
    if (quickCheck?.quick_check !== 'ok')
      throw new Error('The local audit database failed quick_check')
    this.#secureFiles()
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        category TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        correlation_id TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_correlation_idx ON journal(correlation_id);

      CREATE TABLE IF NOT EXISTS operation_ledger (
        attachment_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        intent_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        receipt_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (attachment_id, operation_id)
      );
    `)
  }

  appendJournal(record: JournalRecord): number {
    const statement = this.#database.prepare(`
      INSERT INTO journal (
        occurred_at, category, event_type, actor_type, correlation_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    const result = statement.run(
      new Date().toISOString(),
      record.category,
      record.eventType,
      record.actorType,
      record.correlationId ?? null,
      JSON.stringify(record.payload),
    )
    this.#secureFiles()
    return Number(result.lastInsertRowid)
  }

  registerOperation(input: {
    readonly attachmentId: string
    readonly operationId: string
    readonly intentFingerprint: string
  }): OperationRegistration {
    const existing = this.#database
      .prepare(
        `SELECT intent_fingerprint, state, receipt_json
         FROM operation_ledger WHERE attachment_id = ? AND operation_id = ?`,
      )
      .get(input.attachmentId, input.operationId) as
      | { intent_fingerprint: string; state: string; receipt_json: string | null }
      | undefined

    if (existing !== undefined) {
      if (existing.intent_fingerprint !== input.intentFingerprint) return { status: 'conflict' }
      return {
        status: 'duplicate',
        state: existing.state,
        ...(existing.receipt_json === null ? {} : { receiptJson: existing.receipt_json }),
      }
    }

    const now = new Date().toISOString()
    this.#database
      .prepare(
        `INSERT INTO operation_ledger (
          attachment_id, operation_id, intent_fingerprint, state, created_at, updated_at
        ) VALUES (?, ?, ?, 'received', ?, ?)`,
      )
      .run(input.attachmentId, input.operationId, input.intentFingerprint, now, now)
    this.#secureFiles()
    return { status: 'registered' }
  }

  #secureFiles(): void {
    for (const path of [this.#path, `${this.#path}-wal`, `${this.#path}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  }

  close(): void {
    this.#database.close()
  }
}
