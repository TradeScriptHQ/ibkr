import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const TICKET_TTL_MS = 30_000

interface StoredTicket {
  readonly ticketHash: Buffer
  readonly sessionHash: Buffer
  readonly origin: string
  readonly expiresAtMs: number
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export class WebSocketTicketStore {
  readonly #tickets = new Map<string, StoredTicket>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  issue(
    sessionId: string,
    origin: string,
  ): { readonly ticket: string; readonly expiresAt: string } {
    this.prune()
    const ticket = randomBytes(32).toString('base64url')
    const ticketHash = digest(ticket)
    const expiresAtMs = this.#now() + TICKET_TTL_MS
    this.#tickets.set(ticketHash.toString('hex'), {
      ticketHash,
      sessionHash: digest(sessionId),
      origin,
      expiresAtMs,
    })
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  consume(ticket: string, sessionId: string, origin: string): boolean {
    const candidate = digest(ticket)
    const key = candidate.toString('hex')
    const stored = this.#tickets.get(key)
    this.#tickets.delete(key)
    if (stored === undefined || stored.expiresAtMs <= this.#now() || stored.origin !== origin) {
      return false
    }
    const sessionHash = digest(sessionId)
    return (
      timingSafeEqual(stored.ticketHash, candidate) &&
      timingSafeEqual(stored.sessionHash, sessionHash)
    )
  }

  prune(): void {
    const now = this.#now()
    for (const [key, ticket] of this.#tickets) {
      if (ticket.expiresAtMs <= now) this.#tickets.delete(key)
    }
  }
}
