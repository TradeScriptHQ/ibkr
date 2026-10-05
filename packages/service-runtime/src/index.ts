import { isMainThread, parentPort } from 'node:worker_threads'

export interface LocalService {
  close(): void | Promise<void>
}

const FAILURE_GUIDANCE = {
  'address-in-use':
    'A local service port is already in use. Close the conflicting application and try again.',
  'permission-denied': 'The operating system denied access to a local service resource.',
  'root-launch-required': 'Start the workstation with the root npm run dev command.',
  'invalid-mcp-port': 'Check the configured MCP ports; each must be a valid local TCP port.',
  'origin-port-mismatch': 'TRADESCRIPT_REQUESTED_ORIGIN must use the configured UI_PORT.',
  'non-loopback-host': 'Local service hosts must use the configured literal loopback address.',
  'agent-settings-incomplete':
    'Agent paper trading settings are incomplete. Configure every required risk limit and allowed account.',
  'authorization-settings-incomplete':
    'TradeScript runtime authorization settings are incomplete. Check the credential, SDK version and build fingerprint settings.',
  'invalid-environment':
    'The workstation configuration is invalid. Check .env values, duplicates and owner-only file permissions.',
  'unknown-error':
    'Check the workstation configuration and retry. Private error details have been suppressed.',
} as const

/** Never echo provider errors: they may contain credentials, account IDs or local state. */
function failureCode(error: unknown): keyof typeof FAILURE_GUIDANCE {
  if (typeof error !== 'object' || error === null) return 'unknown-error'
  const code = 'code' in error ? error.code : undefined
  if (code === 'EADDRINUSE') return 'address-in-use'
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied'
  if ('name' in error && error.name === 'ZodError') return 'invalid-environment'
  const message = error instanceof Error ? error.message : undefined
  if (message === 'Start the workstation with the root npm run dev command')
    return 'root-launch-required'
  if (message === 'Invalid MCP port') return 'invalid-mcp-port'
  if (message === 'TRADESCRIPT_REQUESTED_ORIGIN port must equal UI_PORT')
    return 'origin-port-mismatch'
  if (
    ['UI_HOST', 'GATEWAY_HOST', 'IBKR_HOST'].some(
      (host) => message === `${host} must be the literal loopback address 127.0.0.1`,
    )
  )
    return 'non-loopback-host'
  if (message?.startsWith('Agent paper trading is enabled but required limits are missing: '))
    return 'agent-settings-incomplete'
  if (
    message?.startsWith('TradeScript runtime authorization is partially configured; missing ') ||
    message === 'TradeScript runtime authorization requires SDK version and build fingerprint'
  )
    return 'authorization-settings-incomplete'
  if (
    message?.startsWith('.env must ') ||
    message?.startsWith('Duplicate key ') ||
    message?.startsWith('TRADESCRIPT_REQUESTED_ORIGIN must ') ||
    message?.startsWith('TRADESCRIPT_CREDENTIAL_EXCHANGE_URL must ')
  )
    return 'invalid-environment'
  return 'unknown-error'
}

function reportFailure(phase: 'startup' | 'shutdown', error: unknown): void {
  const code = failureCode(error)
  let settings = ''
  if (code === 'agent-settings-incomplete' && error instanceof Error) {
    const allowed = new Set([
      'IBKR_ALLOWED_ACCOUNT_IDS',
      'AGENT_MAX_ORDER_QUANTITY',
      'AGENT_MAX_ORDER_NOTIONAL',
      'AGENT_MAX_POSITION_QUANTITY',
      'AGENT_MAX_POSITION_NOTIONAL',
      'AGENT_MAX_GROSS_EXPOSURE',
      'AGENT_MAX_DAILY_LOSS',
      'AGENT_MAX_ORDERS_PER_MINUTE',
      'AGENT_MAX_ESTIMATED_SLIPPAGE_BPS',
      'AGENT_MAX_MARKET_DATA_AGE_MS',
      'AGENT_MAX_LEVERAGE',
      'AGENT_MAX_UNPROTECTED_POSITION_QUANTITY',
    ])
    const names = error.message
      .slice('Agent paper trading is enabled but required limits are missing: '.length)
      .split(', ')
    if (names.length > 0 && names.every((name) => allowed.has(name)))
      settings = ` Missing settings: ${names.join(', ')}.`
  }
  // The native host consumes only this bounded allowlisted code, never the original error.
  process.stderr.write(`TERMINAL_SERVICE_FAILURE ${phase}:${code}\n`)
  process.stderr.write(
    `The local service failed during ${phase}. ${FAILURE_GUIDANCE[code]}${settings}\n`,
  )
}

/** Both CLI signals and desktop worker messages use the service's own cleanup. */
export async function runService(start: () => Promise<LocalService>): Promise<void> {
  const service = Promise.resolve().then(start)
  let closing: Promise<void> | undefined
  const stop = () => {
    closing ??= (async () => {
      try {
        await (await service).close()
        process.exit(0)
      } catch (error) {
        reportFailure('shutdown', error)
        process.exit(1)
      }
    })()
    return closing
  }
  if (isMainThread) {
    process.once('SIGINT', () => void stop())
    process.once('SIGTERM', () => void stop())
  } else {
    parentPort?.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'stop'
      )
        void stop()
    })
  }
  try {
    await service
    if (!closing) parentPort?.postMessage({ type: 'ready' })
  } catch (error) {
    reportFailure('startup', error)
    process.exit(1)
  }
}
