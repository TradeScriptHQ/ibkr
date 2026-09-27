import { rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRootEnvironment } from '../apps/gateway/src/environment.js'

export async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

// dotenv does not unescape JSON-style `\\`, so a Windows path written with JSON.stringify reads
// back with doubled separators. Single quotes preserve the value literally, and plain values need
// no quoting at all.
function quoteEnvValue(value: string | undefined): string {
  if (value === undefined || value.length === 0) return '""'
  if (/[\s#'"\\]/u.test(value)) return `'${value}'`
  return value
}

export async function isolatedMockEnvironment(
  uiPort: number,
  source: NodeJS.ProcessEnv = loadRootEnvironment(),
) {
  if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535)
    throw new Error('Invalid isolated mock UI port')
  const directory = await mkdtemp(join(tmpdir(), 'terminal-mock-e2e-'))
  const environment: NodeJS.ProcessEnv = {}
  // Only SDK authorization/source settings carry over. Broker connections and account state do not.
  for (const name of [
    'TRADESCRIPT_CREDENTIAL_ID',
    'TRADESCRIPT_CREDENTIAL_SECRET',
    'TRADESCRIPT_CREDENTIAL_EXCHANGE_URL',
    'TRADESCRIPT_SDK_SOURCE',
  ]) {
    if (source[name] !== undefined) environment[name] = source[name]
  }
  Object.assign(environment, {
    NODE_ENV: 'development',
    VITE_TRADING_MODE: 'mock',
    UI_PORT: String(uiPort),
    UI_ORIGIN: `http://localhost:${uiPort}`,
    TRADESCRIPT_REQUESTED_ORIGIN: `http://localhost:${uiPort}`,
    GATEWAY_PORT: String(await unusedPort()),
    TRADESCRIPT_MCP_HTTP_PORT: String(await unusedPort()),
    TRADESCRIPT_MCP_BRIDGE_PORT: String(await unusedPort()),
    TERMINAL_DATA_DIR: join(directory, 'state'),
    IBKR_EXECUTION_ENVIRONMENT: 'paper',
    IBKR_ALLOWED_ACCOUNT_IDS: '',
    AGENT_TRADING_ENABLED: 'false',
  })
  const path = join(directory, '.env')
  await writeFile(
    path,
    Object.entries(environment)
      .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
      .join('\n'),
    { mode: 0o600 },
  )
  return {
    environment: { ...environment, TERMINAL_ENV_FILE: path },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}
