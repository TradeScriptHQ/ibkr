import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGatewayConfig } from './config.js'
import { createBrokerRuntime } from './connections/broker-runtime.js'
import { ConnectionManager } from './connections/connection-manager.js'
import { loadRootEnvironment } from './environment.js'
import { EventStream } from './events/event-stream.js'
import { LocalDatabase } from './persistence/database.js'
import { SessionStore } from './security/session-store.js'
import { WebSocketTicketStore } from './security/websocket-tickets.js'
import { createGatewayServer } from './server.js'
import { buildSystemStatus } from './status.js'
import { CredentialStore, clearRetiredAccountSession } from './tradescript/credential-store.js'
import { Licensing } from './tradescript/licensing.js'

export async function startGatewayService() {
  const environment =
    process.env.TERMINAL_DESKTOP === '1'
      ? { ...process.env }
      : loadRootEnvironment(process.env, process.env.TERMINAL_ENV_FILE)
  delete environment.TRADESCRIPT_NPM_TOKEN
  // Artifact metadata is public and must match the installed SDK, never a stale handoff.
  try {
    const root = dirname(
      dirname(dirname(fileURLToPath(import.meta.resolve('@tradescript/pro/sdk/core')))),
    )
    const identity = JSON.parse(readFileSync(join(root, 'dist/build-identity/core.json'), 'utf8'))
    environment.TRADESCRIPT_SDK_VERSION = identity.package.version
    environment.TRADESCRIPT_CUSTOMER_BUILD_FINGERPRINT =
      identity.buildIdentity.customerBuildFingerprint
  } catch {
    /* Desktop metadata is supplied by the packaged runtime. */
  }
  const initialConfig = loadGatewayConfig(environment)
  const stateDirectory =
    environment.TERMINAL_DATA_DIR ??
    fileURLToPath(new URL('../../../.local/state', import.meta.url))
  clearRetiredAccountSession(join(stateDirectory, 'tradescript-account.json'))
  const dataPath = join(stateDirectory, 'terminal.sqlite')
  const database = new LocalDatabase(dataPath)
  const sessions = new SessionStore()
  const tickets = new WebSocketTicketStore()
  const events = new EventStream()
  const connections = new ConnectionManager(
    initialConfig,
    (config) =>
      createBrokerRuntime(config, () =>
        events.publish({ type: 'readiness.changed', status: getStatus() }),
      ),
    join(stateDirectory, 'connections.json'),
  )
  const config = initialConfig
  const leases = new Licensing(
    config.tradescript,
    new CredentialStore(
      join(stateDirectory, 'sdk-credentials.json'),
      environment.TERMINAL_CREDENTIAL_KEY
        ? Buffer.from(environment.TERMINAL_CREDENTIAL_KEY, 'base64')
        : undefined,
    ),
  )
  const proxyCapability =
    process.env.INTERNAL_PROXY_CAPABILITY ?? randomBytes(32).toString('base64url')

  let sdkInstalled = environment.TERMINAL_DESKTOP === '1'
  try {
    import.meta.resolve('@tradescript/pro/sdk/core')
    sdkInstalled = true
  } catch {
    sdkInstalled = environment.TERMINAL_DESKTOP === '1'
  }

  const runtime = {
    auditDatabaseReady: true,
    sdkInstalled,
  }
  const getStatus = () =>
    buildSystemStatus(
      { ...connections.config, tradescript: leases.config },
      connections.runtime.tws.snapshot(),
      {
        ...runtime,
        leaseReady: leases.snapshot().ready,
      },
    )

  let previousLeaseState = leases.snapshot().state
  leases.subscribe((snapshot) => {
    if (snapshot.state !== previousLeaseState) {
      previousLeaseState = snapshot.state
      events.publish({
        type: 'connection.status',
        component: 'tradescript',
        state: snapshot.ready ? 'ready' : snapshot.state === 'exchanging' ? 'connecting' : 'error',
        message: snapshot.message,
      })
    }
    events.publish({ type: 'readiness.changed', status: getStatus() })
  })

  const app = await createGatewayServer({
    get config() {
      return { ...connections.config, tradescript: leases.config }
    },
    connections,
    proxyCapability,
    sessions,
    tickets,
    events,
    getStatus,
    leases,
    licensing: leases,
    get ibkr() {
      return connections.runtime.ibkr
    },
    get brokerStore() {
      return connections.runtime.brokerStore
    },
    database,
  })

  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      try {
        connections.runtime.stop()
        leases.stop()
        await app.close()
      } finally {
        database.close()
      }
    })()
    return closing
  }
  try {
    await app.listen({ host: config.gateway.host, port: config.gateway.port })
    if (
      environment.VITE_TRADING_MODE !== 'mock' &&
      (environment.TERMINAL_DESKTOP !== '1' || existsSync(join(stateDirectory, 'connections.json')))
    )
      connections.runtime.start()
    leases.start()
  } catch (error) {
    await close()
    throw error
  }
  return { close }
}
