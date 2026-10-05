import type { MarketSessionState } from '@ibkr-terminal/contracts'

/** A failed/unknown provider response must fail qualification, not skip an execution test. */
export function requireKnownSessionState(session: unknown): MarketSessionState {
  const state =
    typeof session === 'object' && session !== null && 'currentState' in session
      ? session.currentState
      : undefined
  if (
    state !== 'regular' &&
    state !== 'closed' &&
    state !== 'pre-market' &&
    state !== 'post-market' &&
    state !== 'holiday' &&
    state !== 'extended'
  )
    throw new Error('IBKR returned no known market-session state')
  return state
}
