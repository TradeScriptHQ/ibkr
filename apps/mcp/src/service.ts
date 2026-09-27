import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import { BrowserBridge } from './browser-bridge.js'
import { bridgeError, MAX_BODY_BYTES, safeEqual, sendJson } from './http.js'
import { createMcpTransport } from './transport.js'

export interface McpServiceOptions {
  readonly httpPort: number
  readonly bridgePort: number
  readonly uiOrigin: string
  readonly capability: string
}

export async function startMcpService(options: McpServiceOptions) {
  const host = '127.0.0.1'
  const bridge = new BrowserBridge()
  const transport = createMcpTransport(bridge)
  const httpServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${host}:${options.httpPort}`)
      if (url.pathname === '/healthz' && request.method === 'GET') {
        sendJson(response, 200, { status: 'ok', attachedSessions: bridge.sessions().length })
      } else if (url.pathname === '/sessions' && request.method === 'GET') {
        sendJson(response, 200, bridge.sessions())
      } else if (url.pathname === '/browser-session' && request.method === 'POST') {
        const capability = request.headers['x-terminal-proxy-capability']
        if (typeof capability !== 'string' || !safeEqual(capability, options.capability)) {
          sendJson(response, 403, {
            error: { code: 'FORBIDDEN', message: 'The terminal proxy capability is required' },
          })
          return
        }
        const session = bridge.issueSession()
        sendJson(response, 201, {
          sessionId: session.sessionId,
          mcpUrl: `http://${host}:${options.httpPort}/mcp`,
          bridgeUrl: `ws://${host}:${options.bridgePort}/bridge`,
          bridgeToken: session.token,
          expiresAt: new Date(session.expiresAt).toISOString(),
        })
      } else if (
        url.pathname === '/mcp' &&
        ['GET', 'POST', 'DELETE'].includes(request.method ?? '')
      ) {
        await transport.handle(request, response)
      } else sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } })
    })().catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: bridgeError(error) })
      else response.destroy(error instanceof Error ? error : undefined)
    })
  })
  const bridgeServer = createServer()
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES })
  bridgeServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${host}:${options.bridgePort}`)
    if (url.pathname !== '/bridge' || request.headers.origin !== options.uiOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => bridge.accept(websocket))
  })
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      bridge.close()
      try {
        await transport.close()
      } finally {
        await Promise.all([
          new Promise<void>((resolve) => sockets.close(() => resolve())),
          ...[httpServer, bridgeServer].map(
            (server) =>
              new Promise<void>((resolve) => {
                server.close(() => resolve())
                server.closeAllConnections()
              }),
          ),
        ])
      }
    })()
    return closing
  }
  const listen = (server: Server, port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  try {
    await listen(httpServer, options.httpPort)
    await listen(bridgeServer, options.bridgePort)
  } catch (error) {
    await close()
    throw error
  }
  return { close }
}
