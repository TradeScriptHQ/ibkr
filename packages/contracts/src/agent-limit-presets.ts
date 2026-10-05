import type { AgentRiskLimits } from './api.js'

// Monetary limits are in the selected broker account's base currency.
// Quantity caps are explicitly unbounded; value and execution limits still apply.
export const AGENT_LIMIT_PRESETS = [
  {
    id: 'conservative',
    label: 'Conservative',
    limits: {
      maxOrderQuantity: null,
      maxOrderNotional: 500,
      maxPositionQuantity: null,
      maxPositionNotional: 2_000,
      maxGrossExposure: 5_000,
      maxDailyLoss: 100,
      maxOrdersPerMinute: 5,
      maxEstimatedSlippageBps: 10,
      maxMarketDataAgeMs: 5_000,
      maxLeverage: 1,
      maxUnprotectedPositionQuantity: null,
    },
  },
  {
    id: 'normal',
    label: 'Normal',
    limits: {
      maxOrderQuantity: null,
      maxOrderNotional: 2_500,
      maxPositionQuantity: null,
      maxPositionNotional: 10_000,
      maxGrossExposure: 25_000,
      maxDailyLoss: 500,
      maxOrdersPerMinute: 10,
      maxEstimatedSlippageBps: 10,
      maxMarketDataAgeMs: 5_000,
      maxLeverage: 1,
      maxUnprotectedPositionQuantity: null,
    },
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    limits: {
      maxOrderQuantity: null,
      maxOrderNotional: 10_000,
      maxPositionQuantity: null,
      maxPositionNotional: 25_000,
      maxGrossExposure: 100_000,
      maxDailyLoss: 2_000,
      maxOrdersPerMinute: 20,
      maxEstimatedSlippageBps: 10,
      maxMarketDataAgeMs: 5_000,
      maxLeverage: 1,
      maxUnprotectedPositionQuantity: null,
    },
  },
] as const satisfies readonly {
  readonly id: string
  readonly label: string
  readonly limits: AgentRiskLimits
}[]

export type AgentLimitPresetId = (typeof AGENT_LIMIT_PRESETS)[number]['id']

export function matchingAgentLimitPreset(
  limits: Partial<AgentRiskLimits>,
): AgentLimitPresetId | undefined {
  return AGENT_LIMIT_PRESETS.find((preset) =>
    (Object.keys(preset.limits) as Array<keyof AgentRiskLimits>).every(
      (key) => limits[key] === preset.limits[key],
    ),
  )?.id
}
