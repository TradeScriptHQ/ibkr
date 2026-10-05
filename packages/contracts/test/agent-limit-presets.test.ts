import { describe, expect, it } from 'vitest'
import {
  AGENT_LIMIT_PRESETS,
  AgentRiskLimitsSchema,
  matchingAgentLimitPreset,
} from '../src/index.js'

describe('agent limit presets', () => {
  it('provides complete value-based policies for every level', () => {
    for (const preset of AGENT_LIMIT_PRESETS) {
      expect(AgentRiskLimitsSchema.parse(preset.limits)).toEqual(preset.limits)
      expect(preset.limits).toMatchObject({
        maxOrderQuantity: null,
        maxPositionQuantity: null,
        maxUnprotectedPositionQuantity: null,
        maxLeverage: 1,
      })
      expect(preset.limits.maxOrderNotional).toBeLessThanOrEqual(preset.limits.maxPositionNotional)
      expect(preset.limits.maxPositionNotional).toBeLessThanOrEqual(preset.limits.maxGrossExposure)
      expect(preset.limits.maxDailyLoss).toBeLessThan(preset.limits.maxGrossExposure)
    }
  })

  it('increases value budgets without loosening quote freshness, slippage or leverage', () => {
    for (const [previous, next] of [
      [AGENT_LIMIT_PRESETS[0].limits, AGENT_LIMIT_PRESETS[1].limits],
      [AGENT_LIMIT_PRESETS[1].limits, AGENT_LIMIT_PRESETS[2].limits],
    ] as const) {
      for (const key of [
        'maxOrderNotional',
        'maxPositionNotional',
        'maxGrossExposure',
        'maxDailyLoss',
        'maxOrdersPerMinute',
      ] as const) {
        expect(next[key]).toBeGreaterThan(previous[key])
      }
      for (const key of ['maxMarketDataAgeMs', 'maxEstimatedSlippageBps', 'maxLeverage'] as const) {
        expect(next[key]).toBe(previous[key])
      }
    }
  })

  it('recognizes copied saved policies and treats changes or incomplete policies as custom', () => {
    for (const preset of AGENT_LIMIT_PRESETS) {
      expect(matchingAgentLimitPreset({ ...preset.limits })).toBe(preset.id)
      expect(matchingAgentLimitPreset({ ...preset.limits, maxDailyLoss: 37 })).toBeUndefined()
      expect(matchingAgentLimitPreset({ ...preset.limits, maxOrderQuantity: 2 })).toBeUndefined()
    }
    expect(matchingAgentLimitPreset({})).toBeUndefined()
  })
})
