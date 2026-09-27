import type { RequirementStatus, SystemStatusResponse } from '@ibkr-terminal/contracts'
import type { GatewayConfig } from './config.js'
import type { TwsSessionSnapshot } from './tws/tws-session.js'

export interface RuntimeReadiness {
  readonly auditDatabaseReady: boolean
  readonly sdkInstalled: boolean
  readonly leaseReady: boolean
}

function requirement(
  id: string,
  label: string,
  state: RequirementStatus['state'],
  message: string,
  requiredForTrading: boolean,
): RequirementStatus {
  return { id, label, state, message, requiredForTrading }
}

export function buildSystemStatus(
  config: GatewayConfig,
  tws: TwsSessionSnapshot,
  runtime: RuntimeReadiness,
): SystemStatusResponse {
  const accountAllowlistConfigured = config.ibkr.allowedAccountIds.length > 0
  const accountMatched = tws.matchedAccountIds.length > 0
  const twsReady = tws.state === 'ready' && tws.reconciliationComplete
  const runtimeCredentials = config.tradescript.runtimeCredentialsConfigured

  const requirements: RequirementStatus[] = [
    requirement(
      'tradescript-package',
      'TradeScript localhost SDK',
      runtime.sdkInstalled ? 'ready' : 'setup-required',
      runtime.sdkInstalled
        ? 'The exact localhost SDK artifact is installed.'
        : 'A fresh Developer Console npm handoff is required.',
      true,
    ),
    requirement(
      'tradescript-lease',
      'TradeScript browser authorization',
      runtime.leaseReady ? 'ready' : 'setup-required',
      runtime.leaseReady
        ? 'A valid exact-origin browser lease is available.'
        : runtimeCredentials
          ? 'Runtime credentials are configured; lease exchange is not active yet.'
          : 'Developer Console runtime credentials are required.',
      true,
    ),
    requirement(
      'audit-database',
      'Durable audit ledger',
      runtime.auditDatabaseReady ? 'ready' : 'error',
      runtime.auditDatabaseReady
        ? 'The owner-only SQLite audit ledger is writable.'
        : 'The audit ledger is unavailable; financial actions are blocked.',
      true,
    ),
    requirement(
      'tws-session',
      `TWS ${config.ibkr.executionEnvironment} session`,
      tws.state === 'ready' ? 'ready' : tws.state,
      tws.message,
      true,
    ),
    requirement(
      'paper-account',
      `Allowed ${config.ibkr.executionEnvironment} account`,
      accountMatched ? 'ready' : 'setup-required',
      accountMatched
        ? 'The connected TWS session contains an allowlisted account.'
        : accountAllowlistConfigured
          ? 'No connected TWS account matches the configured allowlist.'
          : 'Choose the allowed accounts in Connection settings.',
      true,
    ),
    requirement(
      'agent-risk',
      'Independent-agent risk envelope',
      config.agents.enabled ? 'ready' : 'disabled',
      config.agents.enabled
        ? 'Agent trading is enabled for this connection.'
        : 'Agent trading is disabled for this connection.',
      false,
    ),
  ]

  const connectionReady = twsReady && accountMatched && runtime.auditDatabaseReady
  const tradingEnabled =
    connectionReady &&
    (config.ibkr.tradingEnabled ??
      (config.ibkr.executionEnvironment === 'paper' || config.ibkr.liveOrdersEnabled))
  const ready = connectionReady && runtime.sdkInstalled && runtime.leaseReady && runtimeCredentials

  return {
    service: 'ibkr-trading-gateway',
    version: '0.1.0',
    environment: config.ibkr.executionEnvironment,
    ready,
    tradingEnabled,
    generatedAt: new Date().toISOString(),
    requirements,
  }
}
