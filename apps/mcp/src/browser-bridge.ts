import { randomBytes, randomUUID } from 'node:crypto'
import { McpBridgeClientMessageSchema } from '@ibkr-terminal/contracts'
import type { WebSocket } from 'ws'
import { bridgeError, safeEqual } from './http.js'

interface AttachedSession {
  readonly sessionId: string
  readonly title: string
  readonly attachedAt: number
  readonly socket: WebSocket
  readonly surfaces: readonly unknown[]
}

interface PendingRequest {
  readonly socket: WebSocket
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timeout: NodeJS.Timeout
}

/** Owns pairing and every request's exact browser socket, independent of MCP transports. */
export class BrowserBridge {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>()
  private readonly attached = new Map<string, AttachedSession>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly sockets = new Set<WebSocket>()
  private readonly prune: NodeJS.Timeout
  private closed = false

  constructor(private readonly requestTimeoutMs = 30_000) {
    this.prune = setInterval(() => {
      for (const [id, session] of this.tokens) {
        if (session.expiresAt <= Date.now()) this.tokens.delete(id)
      }
    }, 15_000)
    this.prune.unref()
  }

  issueSession() {
    if (this.closed) throw new Error('The browser bridge is stopped')
    const sessionId = randomUUID()
    const session = { token: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 60_000 }
    this.tokens.set(sessionId, session)
    return { sessionId, ...session }
  }

  sessions() {
    return [...this.attached.values()].map((session) => ({
      id: session.sessionId,
      title: session.title,
      attachedAt: new Date(session.attachedAt).toISOString(),
      surfaces: session.surfaces,
    }))
  }

  accept(socket: WebSocket): void {
    if (this.closed) {
      socket.terminate()
      return
    }
    this.sockets.add(socket)
    let attachedSessionId: string | undefined
    const timeout = setTimeout(() => socket.close(1008, 'Pairing timed out'), 5_000)
    timeout.unref()
    socket.on('error', () => socket.terminate())
    socket.on('message', (raw) => {
      try {
        const message = McpBridgeClientMessageSchema.parse(JSON.parse(raw.toString()))
        if (message.type === 'attach') {
          if (attachedSessionId !== undefined) throw new Error('This bridge is already attached')
          const pending = this.tokens.get(message.sessionId)
          if (
            !pending ||
            pending.expiresAt <= Date.now() ||
            !safeEqual(pending.token, message.token)
          ) {
            socket.close(1008, 'Invalid or expired bridge token')
            return
          }
          this.tokens.delete(message.sessionId)
          clearTimeout(timeout)
          attachedSessionId = message.sessionId
          this.attached.set(message.sessionId, {
            sessionId: message.sessionId,
            title: message.title,
            attachedAt: Date.now(),
            socket,
            surfaces: message.surfaces,
          })
          socket.send(JSON.stringify({ type: 'attached', sessionId: message.sessionId }))
          return
        }
        if (attachedSessionId === undefined) throw new Error('Attach before responding')
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        if (pending.socket !== socket) throw new Error('This request belongs to another browser')
        this.pending.delete(message.id)
        clearTimeout(pending.timeout)
        if (message.error) {
          pending.reject(
            Object.assign(new Error(message.error.message), { code: message.error.code }),
          )
        } else pending.resolve(message.result)
      } catch (error) {
        socket.close(1007, bridgeError(error).message.slice(0, 120))
      }
    })
    socket.once('close', () => {
      clearTimeout(timeout)
      this.sockets.delete(socket)
      if (attachedSessionId && this.attached.get(attachedSessionId)?.socket === socket) {
        this.attached.delete(attachedSessionId)
      }
      this.rejectPending('The attached browser disconnected before answering', socket)
    })
  }

  async request(sessionId: string, method: string, params: unknown): Promise<unknown> {
    const session = this.attached.get(sessionId)
    if (this.closed || !session || session.socket.readyState !== session.socket.OPEN) {
      throw Object.assign(new Error(`TradeScript session ${sessionId} is not attached`), {
        code: 'SESSION_NOT_ATTACHED',
      })
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(
          Object.assign(new Error(`TradeScript browser request ${method} timed out`), {
            code: 'BRIDGE_REQUEST_TIMEOUT',
          }),
        )
      }, this.requestTimeoutMs)
      timeout.unref()
      this.pending.set(id, { socket: session.socket, resolve, reject, timeout })
      const fail = (error: Error) => {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      }
      try {
        session.socket.send(JSON.stringify({ type: 'request', id, method, params }), (error) => {
          if (error) fail(error)
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private rejectPending(reason: string, socket?: WebSocket): void {
    for (const [id, pending] of this.pending) {
      if (socket && pending.socket !== socket) continue
      this.pending.delete(id)
      clearTimeout(pending.timeout)
      pending.reject(Object.assign(new Error(reason), { code: 'BRIDGE_REQUEST_ABANDONED' }))
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.prune)
    this.rejectPending('The MCP bridge stopped before the browser answered')
    for (const socket of this.sockets) socket.terminate()
    this.sockets.clear()
    this.attached.clear()
    this.tokens.clear()
  }
}
