import type { BrokerState, ConnectionSnapshot } from '@ibkr-terminal/contracts'

/** Runtime facts decide whether tests can run; a command-line confirmation proves nothing. */
export function assertPaperConnection(
  connection: ConnectionSnapshot,
  state: Pick<BrokerState, 'connectionStatus' | 'activeAccountId'>,
): void {
  if (connection.settings.active !== 'paper') throw new Error('Broker E2E requires paper mode')
  const profile = connection.settings.profiles.paper
  if ([7496, 4001].includes(profile.port))
    throw new Error('Broker E2E refuses a live TWS/Gateway port')
  if (state.connectionStatus !== 'connected') throw new Error('Broker E2E requires connected TWS')
  if (!state.activeAccountId?.startsWith('DU'))
    throw new Error('Broker E2E requires a paper account')
  if (!profile.allowedAccountIds.includes(state.activeAccountId)) {
    throw new Error('The active paper account must be allowlisted')
  }
}
