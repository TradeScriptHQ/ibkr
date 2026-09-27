import type { GatewayConfig } from '../config.js'

export interface BridgeConfig {
  readonly ibkrHost: string
  readonly ibkrPort: number
  readonly ibkrClientId: number
  readonly backendPort: number
  readonly ibkrMode: 'paper' | 'live'
  readonly liveConnectionAllowed: boolean
  readonly liveOrdersEnabled: boolean
  readonly tradingEnabled?: boolean
  readonly allowedAccountIds: readonly string[]
}

export function createBridgeConfig(config: GatewayConfig): BridgeConfig {
  return {
    ibkrHost: config.ibkr.host,
    ibkrPort: config.ibkr.port,
    ibkrClientId: config.ibkr.clientId,
    backendPort: config.gateway.port,
    ibkrMode: config.ibkr.executionEnvironment,
    liveConnectionAllowed: config.ibkr.executionEnvironment === 'live',
    liveOrdersEnabled: config.ibkr.liveOrdersEnabled,
    ...(config.ibkr.tradingEnabled === undefined
      ? {}
      : { tradingEnabled: config.ibkr.tradingEnabled }),
    allowedAccountIds: config.ibkr.allowedAccountIds,
  }
}
