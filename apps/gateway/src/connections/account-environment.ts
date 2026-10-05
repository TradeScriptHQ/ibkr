/** Keep the broker environment rule shared by connection discovery and readiness. */
export function accountsMatchExecutionEnvironment(
  accounts: readonly string[],
  environment: 'paper' | 'live',
): boolean {
  return (
    accounts.length > 0 &&
    accounts.every((account) => account.startsWith('DU') === (environment === 'paper'))
  )
}
