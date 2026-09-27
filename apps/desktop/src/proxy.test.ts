import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createDesktopProxy } from './proxy.js'

async function request(url: string, options: { headers?: Record<string, string> } = {}) {
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
