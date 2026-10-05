import { type ConnectionRiskAuthority, createConnectionRiskAuthority } from './risk.js'

export type AgentRiskAvailability =
  | { readonly state: 'disabled' }
  | { readonly state: 'checking' }
  | { readonly state: 'ready' }
  | { readonly state: 'unavailable'; readonly message: string }

type InitializedAgentRisk =
  | Exclude<AgentRiskAvailability, { state: 'ready' | 'checking' }>
  | { readonly state: 'ready'; readonly authority: ConnectionRiskAuthority }

/** Agent risk is an optional capability, independently of the chart/broker session. */
export async function initializeWorkstationAgentRisk(
  ...args: Parameters<typeof createConnectionRiskAuthority>
): Promise<InitializedAgentRisk> {
  if (!args[3].enabled) return { state: 'disabled' }
  try {
    const authority = await createConnectionRiskAuthority(...args)
    return { state: 'ready', authority }
  } catch (error: unknown) {
    return {
      state: 'unavailable',
      message:
        error instanceof Error ? error.message : 'The broker risk checks could not be completed.',
    }
  }
}
