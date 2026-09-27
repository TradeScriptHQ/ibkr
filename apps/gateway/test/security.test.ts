import { describe, expect, it } from 'vitest'
import { SessionStore } from '../src/security/session-store.js'
import { WebSocketTicketStore } from '../src/security/websocket-tickets.js'

describe('restart-scoped browser security', () => {
  it('requires both the session and its own CSRF token', () => {
    const sessions = new SessionStore()
    const first = sessions.issue()
    const second = sessions.issue()
    expect(sessions.validate(first.sessionId)).toBe(true)
    expect(sessions.validateCsrf(first.sessionId, first.csrfToken)).toBe(true)
    expect(sessions.validateCsrf(first.sessionId, second.csrfToken)).toBe(false)
    sessions.revoke(first.sessionId)
    expect(sessions.validate(first.sessionId)).toBe(false)
  })

  it('expires idle sessions', () => {
    let now = 1_000
    const sessions = new SessionStore(() => now)
    const issued = sessions.issue()
    now += 30 * 60 * 1000 + 1
    expect(sessions.validate(issued.sessionId)).toBe(false)
  })

  it('uses single-use, session-bound WebSocket tickets', () => {
    const tickets = new WebSocketTicketStore()
    const issued = tickets.issue('session-a', 'http://localhost:3000')
    expect(tickets.consume(issued.ticket, 'session-b', 'http://localhost:3000')).toBe(false)

    const replacement = tickets.issue('session-a', 'http://localhost:3000')
    expect(tickets.consume(replacement.ticket, 'session-a', 'http://localhost:3000')).toBe(true)
    expect(tickets.consume(replacement.ticket, 'session-a', 'http://localhost:3000')).toBe(false)
  })
})
