import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { createDesktopProxy } from './proxy.js'
import { ServiceWorkers } from './service-workers.js'

process.umask(0o077)
const directory = dirname(fileURLToPath(import.meta.url))
const input = createInterface({ input: process.stdin })
// Retain shutdown requests that arrive while configuration/metadata is still loading.
let stopRequested = false
input.on('close', () => {
  stopRequested = true
})
input.on('line', (value) => {
  if (value === 'stop') stopRequested = true
})
const [line] = await new Promise<[string]>((resolve) =>
  input.once('line', (value) => resolve([value])),
)
const settings = JSON.parse(line) as { dataDir: string; credentialKey: string; uiPort?: number }
if (!settings.dataDir || Buffer.from(settings.credentialKey, 'base64').length !== 32)
  throw new Error('Invalid desktop startup configuration')
const metadata = JSON.parse(await readFile(join(directory, 'sdk.json'), 'utf8')) as {
  version: string
  fingerprint: string
}
const requestedPort = settings.uiPort ?? 43871
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)
  throw new Error('Invalid desktop UI port')
const uiPort = requestedPort === 0 ? await freePort() : requestedPort
const origin = `http://127.0.0.1:${uiPort}`
const capability = randomBytes(32).toString('base64url')
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
const gatewayPort = await freePort()
const mcpPort = await freePort()
const bridgePort = await freePort()
const env = {
  PATH: process.env.PATH ?? '',
  SystemRoot: process.env.SystemRoot ?? '',
  NODE_ENV: 'production',
  TERMINAL_DESKTOP: '1',
  TERMINAL_DATA_DIR: settings.dataDir,
  TERMINAL_CREDENTIAL_KEY: settings.credentialKey,
  INTERNAL_PROXY_CAPABILITY: capability,
  UI_PORT: String(uiPort),
  UI_ORIGIN: origin,
  GATEWAY_PORT: String(gatewayPort),
  TRADESCRIPT_REQUESTED_ORIGIN: origin,
  TRADESCRIPT_SDK_VERSION: metadata.version,
  TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT: metadata.fingerprint,
  TRADESCRIPT_MCP_HTTP_PORT: String(mcpPort),
  TRADESCRIPT_MCP_BRIDGE_PORT: String(bridgePort),
}
let proxy: ReturnType<typeof createDesktopProxy> | undefined
let closing: Promise<void> | undefined
let exitCode = 0
const workers = new ServiceWorkers(() => {
  process.stderr.write('A local service stopped unexpectedly.\n')
  void stop(1)
})
function stop(code = 0): Promise<void> {
  exitCode = Math.max(exitCode, code)
  closing ??= (async () => {
    const proxyClosed = new Promise<void>((resolve) => {
      if (!proxy) return resolve()
      proxy.close(() => resolve())
      proxy.closeAllConnections()
    })
    const clean = await workers.close()
    await proxyClosed
    input.close()
    process.exit(clean ? exitCode : 1)
  })()
  return closing
}
input.on('close', () => void stop())
input.on('line', (value) => {
  if (value === 'stop') void stop()
})
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
if (stopRequested) await stop()
try {
  for (const name of ['gateway', 'mcp']) {
    workers.add(new Worker(new URL(`./${name}.mjs`, import.meta.url), { env }))
  }
  await workers.ready()
  if (!closing) {
    proxy = createDesktopProxy({
      origin,
      assets: join(directory, 'web'),
      gatewayPort,
      mcpPort,
      capability,
    })
    proxy.on('error', () => {
      process.stderr.write(
        'The desktop listener could not start. Check for another desktop instance.\n',
      )
      void stop(1)
    })
    proxy.listen(uiPort, '127.0.0.1', () => {
      if (!closing) process.stdout.write(`TERMINAL_READY ${origin}\n`)
    })
  }
} catch {
  if (!closing) {
    process.stderr.write('Local services could not start.\n')
    await stop(1)
  }
}
