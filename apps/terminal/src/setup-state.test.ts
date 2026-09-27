import type { SystemStatusResponse } from '@ibkr-terminal/contracts'
import { describe, expect, it } from 'vitest'
import { requiredReadiness, TERMINAL_COVERAGE } from './setup-state.js'

describe('terminal setup state', () => {
  it('keeps the current exhaustive capability counts visible', () => {
    expect(TERMINAL_COVERAGE).toEqual({
      applicableProducts: 25,
      tradingOperations: 54,
      marketDataFamilies: 23,
    })
  })

  it('counts only requirements that gate trading readiness', () => {
    const status: SystemStatusResponse = {
      service: 'ibkr-trading-gateway',
      version: '0.1.0',
      environment: 'paper',
      ready: false,
      tradingEnabled: false,
      generatedAt: new Date(0).toISOString(),
      requirements: [
        {
          id: 'tws',
          label: 'TWS',
          state: 'ready',
          message: 'Ready',
          requiredForTrading: true,
        },
        {
          id: 'agents',
          label: 'Agents',
          state: 'setup-required',
          message: 'Optional for human trading',
          requiredForTrading: false,
        },
      ],
    }
    expect(requiredReadiness(status)).toEqual({ ready: 1, total: 1 })
  })
})
