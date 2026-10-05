import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, IncomingMessage, type Server } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createDesktopProxy } from './proxy.js'

async function request(
  url: string,
  options: { headers?: Record<string, string>; path?: string } = {},
) {
  return new Promise<{
    status: number
    text(): Promise<string>
    json(): Promise<Record<string, string>>
  }>((resolve, reject) => {
    httpRequest(url, options, (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          text: async () => body,
          json: async () => JSON.parse(body),
        }),
      )
    })
      .on('error', reject)
      .end()
  })
}
const servers: Server[] = []
const directories: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

it('rejects malformed or foreign request targets and keeps serving subsequent requests', async () => {
  let forwarded = 0
  const backendPort = await listen(
    createServer((_request, response) => {
      forwarded += 1
      response.end('available')
    }),
  )
  const port = await listen(
    createDesktopProxy({
      origin: 'http://127.0.0.1:43871',
      assets: tmpdir(),
      gatewayPort: backendPort,
      mcpPort: backendPort,
      capability: 'test-capability',
    }),
  )
  const url = `http://127.0.0.1:${port}`
  for (const path of [
    '//[',
    '//untrusted.test/api/test',
    'http://untrusted.test/api/test',
    '/\\untrusted.test/api/test',
  ]) {
    expect((await request(url, { path, headers: { host: '127.0.0.1:43871' } })).status).toBe(400)
  }
  expect(forwarded).toBe(0)
  const healthy = await request(url, {
    path: '/api/test',
    headers: { host: '127.0.0.1:43871' },
  })
  expect(healthy.status).toBe(200)
  expect(await healthy.text()).toBe('available')
  expect(forwarded).toBe(1)
})

it('closes the upstream event stream when the downstream client disconnects', async () => {
  let upstreamClosed = false
  const backendPort = await listen(
    createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: connected\n\n')
      response.once('close', () => {
        upstreamClosed = true
      })
    }),
  )
  const port = await listen(
    createDesktopProxy({
      origin: 'http://127.0.0.1:43871',
      assets: tmpdir(),
      gatewayPort: backendPort,
      mcpPort: backendPort,
      capability: 'test-capability',
    }),
  )
  await new Promise<void>((resolve, reject) => {
    httpRequest(
      `http://127.0.0.1:${port}/api/events`,
      { headers: { host: '127.0.0.1:43871' } },
      (response) => {
        response.once('data', () => {
          response.destroy()
          resolve()
        })
        response.once('error', reject)
      },
    )
      .once('error', reject)
      .end()
  })
  await expect.poll(() => upstreamClosed, { timeout: 1000 }).toBe(true)
})

it('handles a client socket error after rejecting a websocket upgrade', async () => {
  const proxy = createDesktopProxy({
    origin: 'http://127.0.0.1:43871',
    assets: tmpdir(),
    gatewayPort: 1,
    mcpPort: 1,
    capability: 'test-capability',
  })
  await listen(proxy)
  const socket = new Socket()
  const upgrade = new IncomingMessage(socket)
  upgrade.url = '/api/v1/stream'
  upgrade.headers = { host: '127.0.0.1:43871', origin: 'https://untrusted.test' }
  proxy.emit('upgrade', upgrade, socket, Buffer.alloc(0))
  expect(socket.destroyed).toBe(true)
  expect(() => socket.emit('error', new Error('client connection reset'))).not.toThrow()
})
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return address.port
}
it('serves packaged assets and preserves browser origin while injecting only proxy identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'terminal-proxy-'))
  directories.push(dir)
  await writeFile(join(dir, 'index.html'), '<main>Workstation setup</main>')
  const backendPort = await listen(
    createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(request.headers))
    }),
  )
  // Host and origin refer to the stable app address, even with an isolated test listener.
  const proxy = createDesktopProxy({
    origin: 'http://127.0.0.1:43871',
    assets: dir,
    gatewayPort: backendPort,
    mcpPort: backendPort,
    capability: 'test-capability',
  })
  const port = await listen(proxy)
  const url = `http://127.0.0.1:${port}`
  expect((await request(url)).status).toBe(403)
  expect(await (await request(url, { headers: { host: '127.0.0.1:43871' } })).text()).toContain(
    'Workstation setup',
  )
  const response = await request(`${url}/api/test`, {
    headers: {
      host: '127.0.0.1:43871',
      origin: 'https://untrusted.test',
      'x-terminal-proxy-capability': 'forged',
    },
  })
  const headers = await response.json()
  expect(headers.origin).toBe('https://untrusted.test')
  expect(headers['x-terminal-proxy-capability']).toBe('test-capability')
  expect(headers['sec-fetch-site']).toBeUndefined()
  expect(
    (await request(`${url}/%2e%2e%2fsecret`, { headers: { host: '127.0.0.1:43871' } })).status,
  ).toBe(403)
})
