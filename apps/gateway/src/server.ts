import { timingSafeEqual } from 'node:crypto'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import type { SystemStatusResponse, TradeScriptBootstrapResponse } from '@ibkr-terminal/contracts'
import {
  type ConnectionSettings,
  ConnectionSettingsSchema,
  type ConnectionSnapshot,
} from '@ibkr-terminal/contracts'
import Fastify, { type FastifyReply, type FastifyRequest, LogController } from 'fastify'
import type { RawData } from 'ws'
import type { GatewayConfig } from './config.js'
import type { EventStream } from './events/event-stream.js'
import type { IbkrService } from './ibkr/ibkr-service.js'
import { RequestError } from './ibkr/request-error.js'
import { registerIbkrRoutes } from './ibkr/routes.js'
import type { BrokerStateStore } from './ibkr/state-store.js'
import type { LocalDatabase } from './persistence/database.js'
import { SESSION_COOKIE_NAME, type SessionStore } from './security/session-store.js'
import type { WebSocketTicketStore } from './security/websocket-tickets.js'
import type { TradeScriptLeaseManager } from './tradescript/lease-manager.js'
import type { Licensing } from './tradescript/licensing.js'

const PROXY_HEADER = 'x-terminal-proxy-capability'
const CLIENT_HEADER = 'x-tradescript-client'
const CSRF_HEADER = 'x-tradescript-csrf'
const CLIENT_HEADER_VALUE = 'terminal-v1'
const MAX_SOCKET_BUFFER = 1_000_000

interface GatewayServerOptions {
  readonly licensing?: Pick<Licensing, 'activate' | 'retry' | 'snapshot' | 'config'>
  readonly connections?: {
    snapshot(): ConnectionSnapshot
    switch(
      settings: ConnectionSettings,
      generation: string,
      testId?: string,
    ): Promise<ConnectionSnapshot>
    test?(
      settings: ConnectionSettings,
      generation: string,
    ): Promise<{ testId: string; accounts: string[] }>
    execute<T>(generation: string | undefined, execute: () => T | Promise<T>): Promise<T>
  }
  readonly config: GatewayConfig
  readonly proxyCapability: string
  readonly sessions: SessionStore
  readonly tickets: WebSocketTicketStore
  readonly events: EventStream
  readonly getStatus: () => SystemStatusResponse
  readonly leases?: Pick<TradeScriptLeaseManager, 'getLease'>
  readonly ibkr?: IbkrService
  readonly brokerStore?: BrokerStateStore
  readonly database?: Pick<LocalDatabase, 'appendJournal'>
}

function safeEqual(left: string | undefined, right: string): boolean {
  if (left === undefined) return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function duplicateHeader(request: FastifyRequest, headerName: string): boolean {
  let count = 0
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === headerName) count += 1
  }
  return count > 1
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code:
    | 'bad-request'
    | 'forbidden-origin'
    | 'invalid-session'
    | 'invalid-csrf'
    | 'not-ready'
    | 'not-found'
    | 'internal-error',
  message: string,
): FastifyReply {
  return reply.status(statusCode).send({
    error: { code, message, requestId: request.id },
  })
}

function isJsonRequest(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type']
  return typeof contentType === 'string' && contentType.split(';', 1)[0] === 'application/json'
}

function rawDataLength(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((total, part) => total + part.byteLength, 0)
  return raw.byteLength
}

function rawDataText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  return Buffer.from(new Uint8Array(raw)).toString('utf8')
}

export async function createGatewayServer(options: GatewayServerOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024,
    requestIdHeader: false,
    logController: new LogController({ disableRequestLogging: true }),
  })
  const uiHost = new URL(options.config.ui.origin).host
  const gatewayHost = `${options.config.gateway.host}:${options.config.gateway.port}`
  const activeSockets = new Map<string, Set<{ close(code?: number, reason?: string): void }>>()

  await app.register(cookie)
  await app.register(websocket, {
    options: { perMessageDeflate: false, maxPayload: 64 * 1024 },
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    reply.removeHeader('server')
    return payload
  })

  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?', 1)[0]
    const isProbe = pathname === '/healthz' || pathname === '/readyz'
    const expectedHost = isProbe ? gatewayHost : uiHost

    if (duplicateHeader(request, 'host') || request.headers.host !== expectedHost) {
      return sendError(request, reply, 400, 'bad-request', 'The request host is not allowed.')
    }
    if (isProbe) return
    if (
      duplicateHeader(request, PROXY_HEADER) ||
      !safeEqual(request.headers[PROXY_HEADER] as string | undefined, options.proxyCapability)
    ) {
      return sendError(request, reply, 403, 'bad-request', 'Direct gateway access is not allowed.')
    }
    if (
      duplicateHeader(request, CLIENT_HEADER) ||
      request.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE
    ) {
      return sendError(request, reply, 403, 'bad-request', 'The terminal client header is missing.')
    }
    const isWebSocketUpgrade =
      pathname === '/api/v1/stream' && request.headers.upgrade?.toLowerCase() === 'websocket'
    const fetchSite = request.headers['sec-fetch-site']
    if (
      (!isWebSocketUpgrade && fetchSite !== 'same-origin') ||
      (isWebSocketUpgrade && fetchSite !== undefined && fetchSite !== 'same-origin')
    ) {
      return sendError(
        request,
        reply,
        403,
        'forbidden-origin',
        'A same-origin browser request is required.',
      )
    }
    const origin = request.headers.origin
    if (isWebSocketUpgrade && origin !== options.config.ui.origin) {
      return sendError(
        request,
        reply,
        403,
        'forbidden-origin',
        'The exact WebSocket origin is required.',
      )
    }
    if (origin !== undefined && origin !== options.config.ui.origin) {
      return sendError(
        request,
        reply,
        403,
        'forbidden-origin',
        'The browser origin is not allowed.',
      )
    }
  })

  const requireSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME]
    if (!options.sessions.validate(sessionId)) {
      return sendError(
        request,
        reply,
        401,
        'invalid-session',
        'The local session is invalid or expired.',
      )
    }
  }

  const requireMutation = async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin
    if (origin !== options.config.ui.origin) {
      return sendError(
        request,
        reply,
        403,
        'forbidden-origin',
        'The exact browser origin is required.',
      )
    }
    if (!isJsonRequest(request)) {
      return sendError(request, reply, 415, 'bad-request', 'Mutations require application/json.')
    }
    if (duplicateHeader(request, CSRF_HEADER)) {
      return sendError(
        request,
        reply,
        400,
        'bad-request',
        'Duplicate security headers are not allowed.',
      )
    }
    const csrf = request.headers[CSRF_HEADER]
    if (
      typeof csrf !== 'string' ||
      !options.sessions.validateCsrf(request.cookies[SESSION_COOKIE_NAME], csrf)
    ) {
      return sendError(request, reply, 403, 'invalid-csrf', 'The CSRF token is invalid.')
    }
  }

  const requireTradingReady = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.getStatus().tradingEnabled) {
      return sendError(
        request,
        reply,
        503,
        'not-ready',
        'Paper trading remains locked until TWS reconciliation and the account allowlist are ready.',
      )
    }
  }

  const recordMutation = (
    request: FastifyRequest,
    eventType: string,
    outcome: 'attempted' | 'succeeded' | 'failed',
  ) => {
    const body = request.body as
      | { metadata?: { operationId?: string; origin?: string } }
      | undefined
    options.database?.appendJournal({
      category: 'broker-mutation',
      eventType: `${eventType}.${outcome}`,
      actorType: body?.metadata?.origin === 'mcp' ? 'agent' : 'human',
      correlationId: body?.metadata?.operationId ?? request.id,
      payload: {
        route: request.routeOptions.url ?? request.url,
        method: request.method,
        ...(body?.metadata?.origin ? { origin: body.metadata.origin } : {}),
      },
    })
  }

  const brokerMutation = async <T>(
    request: FastifyRequest,
    eventType: string,
    execute: () => T | Promise<T>,
  ): Promise<T> => {
    const origin = (request.body as { metadata?: { origin?: string } } | undefined)?.metadata
      ?.origin
    if (origin === 'mcp' && !options.config.agents.enabled)
      throw new RequestError(403, 'Agent trading is disabled for this connection.')
    recordMutation(request, eventType, 'attempted')
    try {
      const result = await (options.connections
        ? options.connections.execute(
            typeof request.headers['x-tradescript-connection'] === 'string'
              ? request.headers['x-tradescript-connection']
              : undefined,
            execute,
          )
        : execute())
      recordMutation(request, eventType, 'succeeded')
      return result
    } catch (error) {
      recordMutation(request, eventType, 'failed')
      throw error
    }
  }

  const setSessionCookie = (reply: FastifyReply, sessionId: string) => {
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: options.config.ui.origin.startsWith('https://'),
      maxAge: 12 * 60 * 60,
    })
  }

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/readyz', async (_request, reply) => {
    const status = options.getStatus()
    if (status.ready) return { status: 'ready' }
    return reply.status(503).send({ status: 'not-ready' })
  })

  app.post('/api/v1/session/bootstrap', async (request, reply) => {
    if (request.headers.origin !== options.config.ui.origin || !isJsonRequest(request)) {
      return sendError(
        request,
        reply,
        403,
        'forbidden-origin',
        'Session bootstrap requires the exact browser origin.',
      )
    }
    const issued = options.sessions.issue()
    setSessionCookie(reply, issued.sessionId)
    return { csrfToken: issued.csrfToken, expiresAt: issued.expiresAt }
  })

  app.post(
    '/api/v1/session/refresh',
    { preHandler: [requireSession, requireMutation] },
    async (request, reply) => {
      const previousSession = request.cookies[SESSION_COOKIE_NAME]
      options.sessions.revoke(previousSession)
      const sockets = previousSession === undefined ? undefined : activeSockets.get(previousSession)
      if (sockets !== undefined) {
        for (const socket of sockets) socket.close(1008, 'Session refreshed')
        activeSockets.delete(previousSession as string)
      }
      const issued = options.sessions.issue()
      setSessionCookie(reply, issued.sessionId)
      return { csrfToken: issued.csrfToken, expiresAt: issued.expiresAt }
    },
  )

  app.delete(
    '/api/v1/session',
    { preHandler: [requireSession, requireMutation] },
    async (request, reply) => {
      const sessionId = request.cookies[SESSION_COOKIE_NAME]
      options.sessions.revoke(sessionId)
      if (sessionId !== undefined) {
        const sockets = activeSockets.get(sessionId)
        if (sockets !== undefined) {
          for (const socket of sockets) socket.close(1008, 'Session revoked')
          activeSockets.delete(sessionId)
        }
      }
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
      return reply.status(204).send()
    },
  )

  if (options.licensing) {
    const licensing = options.licensing
    app.get('/api/v1/setup', { preHandler: requireSession }, async () => {
      const authorization = licensing.snapshot()
      return {
        sdk: {
          configured: licensing.config.runtimeCredentialsConfigured,
          ready: authorization.ready,
          state: authorization.state,
          failure: authorization.failure,
          expiresAt: authorization.expiresAt,
          version: licensing.config.sdkVersion,
        },
        connectionConfigured: options.config.ibkr.allowedAccountIds.length > 0,
      }
    })
    app.put('/api/v1/setup/sdk', { preHandler: [requireSession, requireMutation] }, (request) =>
      licensing.activate(request.body),
    )
    app.post('/api/v1/setup/sdk/retry', { preHandler: [requireSession, requireMutation] }, () =>
      licensing.retry(),
    )
  }

  app.get('/api/v1/status', { preHandler: requireSession }, async () => options.getStatus())

  app.get(
    '/api/v1/tradescript/bootstrap',
    { preHandler: requireSession },
    async (request, reply): Promise<TradeScriptBootstrapResponse | FastifyReply> => {
      if (options.leases === undefined) {
        return sendError(
          request,
          reply,
          503,
          'not-ready',
          'TradeScript browser authorization is unavailable.',
        )
      }
      try {
        const lease = await options.leases.getLease()
        return {
          ...lease,
          paperTrading: {
            enabled: options.config.agents.enabled,
            autonomyMode: options.config.agents.autonomyMode,
            allowedAccountIds: [...options.config.ibkr.allowedAccountIds],
            ...(options.config.agents.riskLimits === undefined
              ? {}
              : { limits: options.config.agents.riskLimits }),
          },
        }
      } catch {
        return sendError(
          request,
          reply,
          503,
          'not-ready',
          'TradeScript browser authorization is not ready.',
        )
      }
    },
  )

  if (options.ibkr && options.brokerStore) {
    registerIbkrRoutes(app, {
      get config() {
        return options.config
      },
      get ibkr() {
        return options.ibkr!
      },
      get brokerStore() {
        return options.brokerStore!
      },
      authenticated: { preHandler: requireSession },
      financialMutation: { preHandler: [requireSession, requireMutation, requireTradingReady] },
      brokerMutation,
    })
  }

  const connections = options.connections
  if (connections) {
    app.get('/api/v1/connection', { preHandler: requireSession }, async () =>
      connections.snapshot(),
    )
    app.post(
      '/api/v1/connection/test',
      { preHandler: [requireSession, requireMutation] },
      async (request) => {
        const body = request.body as { settings?: unknown; generation?: string; testId?: string }
        const parsed = ConnectionSettingsSchema.safeParse(body?.settings)
        if (!parsed.success || typeof body?.generation !== 'string')
          throw new RequestError(400, 'Invalid connection settings.')
        if (!connections.test) throw new RequestError(503, 'Connection testing is unavailable.')
        return connections.test(parsed.data, body.generation)
      },
    )
    app.put(
      '/api/v1/connection',
      { preHandler: [requireSession, requireMutation] },
      async (request) => {
        const body = request.body as { settings?: unknown; generation?: string; testId?: string }
        const parsed = ConnectionSettingsSchema.safeParse(body?.settings)
        if (!parsed.success || typeof body?.generation !== 'string')
          throw new RequestError(400, 'Invalid connection settings.')
        return connections.switch(parsed.data, body.generation, body.testId)
      },
    )
  }

  app.get('/api/v1/events/snapshot', { preHandler: requireSession }, async () => ({
    sessionGeneration: options.events.generation,
    cursor: options.events.cursor,
    status: options.getStatus(),
  }))

  app.post(
    '/api/v1/ws-tickets',
    { preHandler: [requireSession, requireMutation] },
    async (request) => {
      const sessionId = request.cookies[SESSION_COOKIE_NAME] as string
      return options.tickets.issue(sessionId, options.config.ui.origin)
    },
  )

  app.get(
    '/api/v1/stream',
    { websocket: true, preValidation: requireSession },
    (socket, request) => {
      const sessionId = request.cookies[SESSION_COOKIE_NAME]
      if (sessionId === undefined) {
        socket.close(1008, 'Missing session')
        return
      }

      let authenticated = false
      let unsubscribe: (() => void) | undefined
      const authTimer = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5_000)

      socket.once('message', (raw: RawData, isBinary: boolean) => {
        if (isBinary || rawDataLength(raw) > 4_096) {
          socket.close(1008, 'Invalid authentication frame')
          return
        }
        let input: unknown
        try {
          input = JSON.parse(rawDataText(raw))
        } catch {
          socket.close(1008, 'Invalid authentication frame')
          return
        }
        if (
          typeof input !== 'object' ||
          input === null ||
          !('type' in input) ||
          input.type !== 'authenticate' ||
          !('ticket' in input) ||
          typeof input.ticket !== 'string' ||
          !options.tickets.consume(input.ticket, sessionId, options.config.ui.origin)
        ) {
          socket.close(1008, 'Invalid WebSocket ticket')
          return
        }

        clearTimeout(authTimer)
        authenticated = true
        const sessionSockets = activeSockets.get(sessionId) ?? new Set()
        sessionSockets.add(socket)
        activeSockets.set(sessionId, sessionSockets)
        socket.send(
          JSON.stringify({
            type: 'snapshot',
            sessionGeneration: options.events.generation,
            cursor: options.events.cursor,
            status: options.getStatus(),
          }),
        )
        unsubscribe = options.events.subscribe((envelope) => {
          if (socket.bufferedAmount > MAX_SOCKET_BUFFER) {
            socket.close(1013, 'Slow consumer; request a fresh snapshot')
            return
          }
          socket.send(JSON.stringify({ type: 'event', envelope }))
        })
      })

      socket.on('message', (_raw: RawData) => {
        if (!authenticated) return
        // V1 is a server-push stream. Client commands use authenticated HTTP routes.
      })

      socket.on('close', () => {
        clearTimeout(authTimer)
        unsubscribe?.()
        const sessionSockets = activeSockets.get(sessionId)
        sessionSockets?.delete(socket)
        if (sessionSockets?.size === 0) activeSockets.delete(sessionId)
      })
    },
  )

  app.setNotFoundHandler(async (request, reply) =>
    sendError(request, reply, 404, 'not-found', 'The requested route does not exist.'),
  )

  app.setErrorHandler(async (error, request, reply) => {
    if (reply.sent) return
    const candidateStatus =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500
    const statusCode =
      error instanceof RequestError && candidateStatus >= 400 && candidateStatus <= 599
        ? candidateStatus
        : candidateStatus < 500
          ? candidateStatus
          : 500
    const publicMessage =
      error instanceof RequestError
        ? error.message
        : statusCode < 500
          ? 'The request was rejected.'
          : 'The gateway could not complete the request.'
    return sendError(
      request,
      reply,
      statusCode,
      statusCode < 500 ? 'bad-request' : 'internal-error',
      publicMessage,
    )
  })

  return app
}
