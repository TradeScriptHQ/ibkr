import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000
const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000

export const SESSION_COOKIE_NAME = 'ts_terminal_session'

interface StoredSession {
  readonly sessionHash: Buffer
  readonly csrfHash: Buffer
  readonly absoluteExpiresAtMs: number
  idleExpiresAtMs: number
}

export interface IssuedSession {
  readonly sessionId: string
  readonly csrfToken: string
  readonly expiresAt: string
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function matches(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

export class SessionStore {
  readonly #sessions = new Map<string, StoredSession>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  issue(): IssuedSession {
    this.prune()
    const sessionId = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(32).toString('base64url')
    const sessionHash = digest(sessionId)
    const now = this.#now()
    const absoluteExpiresAtMs = now + SESSION_ABSOLUTE_TTL_MS
    this.#sessions.set(sessionHash.toString('hex'), {
      sessionHash,
      csrfHash: digest(csrfToken),
      absoluteExpiresAtMs,
      idleExpiresAtMs: now + SESSION_IDLE_TTL_MS,
    })
    return { sessionId, csrfToken, expiresAt: new Date(absoluteExpiresAtMs).toISOString() }
  }

  validate(sessionId: string | undefined): boolean {
    if (sessionId === undefined) return false
    const candidate = digest(sessionId)
    const stored = this.#sessions.get(candidate.toString('hex'))
    const now = this.#now()
    if (
      stored === undefined ||
      stored.idleExpiresAtMs <= now ||
      stored.absoluteExpiresAtMs <= now
    ) {
      return false
    }
    const valid = matches(stored.sessionHash, candidate)
    if (valid)
      stored.idleExpiresAtMs = Math.min(now + SESSION_IDLE_TTL_MS, stored.absoluteExpiresAtMs)
    return valid
  }

  validateCsrf(sessionId: string | undefined, csrfToken: string | undefined): boolean {
    if (sessionId === undefined || csrfToken === undefined) return false
    const candidateSession = digest(sessionId)
    const stored = this.#sessions.get(candidateSession.toString('hex'))
    const now = this.#now()
    if (
      stored === undefined ||
      stored.idleExpiresAtMs <= now ||
      stored.absoluteExpiresAtMs <= now
    ) {
      return false
    }
    return matches(stored.csrfHash, digest(csrfToken))
  }

  revoke(sessionId: string | undefined): void {
    if (sessionId === undefined) return
    this.#sessions.delete(digest(sessionId).toString('hex'))
  }

  prune(): void {
    const now = this.#now()
    for (const [key, session] of this.#sessions) {
      if (session.idleExpiresAtMs <= now || session.absoluteExpiresAtMs <= now) {
        this.#sessions.delete(key)
      }
    }
  }
}
