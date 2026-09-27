import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import httpProxy from 'http-proxy'

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.md': 'text/plain',
}
export function createDesktopProxy(options: {
  origin: string
  assets: string
  gatewayPort: number
  mcpPort: number
  capability: string
}) {
  const expectedHost = new URL(options.origin).host
  const proxy = httpProxy.createProxyServer({ ws: true })
  proxy.on('error', (_error, _request, response) => {
    if ('writeHead' in response && !response.headersSent)
      response.writeHead(502, { 'content-type': 'text/plain' })
    response.end('The local service is unavailable. Restart the application.')
  })
  const headers = {
    'x-terminal-proxy-capability': options.capability,
    'x-tradescript-client': 'terminal-v1',
  }
  const server = createServer((request, response) => {
    if (request.headers.host !== expectedHost) {
      response.writeHead(403).end()
      return
    }
    const pathname = new URL(request.url ?? '/', options.origin).pathname
    if (pathname.startsWith('/api/') || pathname.startsWith('/mcp-local/')) {
      // Keep the browser's Origin/Fetch-Site and cookies; never fabricate browser trust.
      const mcp = pathname.startsWith('/mcp-local/')
      if (mcp) request.url = request.url?.replace(/^\/mcp-local/u, '')
      proxy.web(request, response, {
        target: `http://127.0.0.1:${mcp ? options.mcpPort : options.gatewayPort}`,
        headers,
      })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end()
      return
    }
    void (async () => {
      const root = resolve(options.assets)
      const file = resolve(
        root,
        `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`,
      )
      if (!file.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end()
        return
      }
      const metadata = await stat(file)
      if (!metadata.isFile()) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'content-length': metadata.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "frame-ancestors 'none'",
      })
      if (request.method === 'HEAD') response.end()
      else
        createReadStream(file)
          .on('error', () => response.destroy())
          .pipe(response)
    })().catch(() => {
      if (!response.headersSent) response.writeHead(404)
      response.end()
    })
  })
  server.on('upgrade', (request, socket, head) => {
    if (
      request.headers.host !== expectedHost ||
      request.headers.origin !== options.origin ||
      new URL(request.url ?? '/', options.origin).pathname !== '/api/v1/stream'
    ) {
      socket.destroy()
      return
    }
    proxy.ws(request, socket, head, { target: `http://127.0.0.1:${options.gatewayPort}`, headers })
  })
  server.on('close', () => proxy.close())
  return server
}
