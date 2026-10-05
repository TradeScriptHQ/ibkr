import { describe, expect, it } from 'vitest'
import { toTradingEvent, toTradingState } from './broker-mapping.js'
import type { BackendExecution, BackendState } from './types.js'

const execution: BackendExecution = {
  id: 'synthetic-execution',
  accountId: 'DU123',
  orderId: '1400',
  symbol: { symbol: 'AAPL', assetClass: 'stock', exchange: 'SMART', currency: 'USD' },
  side: 'sell',
  quantity: 2,
  price: 150,
  timestamp: '2026-09-30T14:30:00.000Z',
}

function stateWith(executions: BackendExecution[]): BackendState {
  return {
    connectionStatus: 'connected',
    accounts: [],
    orders: [],
    positions: [],
    executions,
    messages: [],
    diagnostics: [],
    quotes: [],
    updatedAt: execution.timestamp,
  }
}

describe('execution timestamps at the public SDK boundary', () => {
  it('retains the broker execution timestamp rather than the mapping receive time', () => {
    const state = toTradingState(stateWith([execution]), 'IBKR', 'paper')
    expect(state.executions).toHaveLength(1)
    expect(state.executions[0]?.time).toBe(Date.parse(execution.timestamp))
  })

  it.each(['', 'unknown', 'not-a-timestamp'])(
    'omits an execution with unknown timestamp %j only from the SDK state',
    (timestamp) => {
      const unknown: BackendExecution = { ...execution, id: 'untimed-execution', timestamp }
      const backend = stateWith([execution, unknown])
      expect(toTradingState(backend, 'IBKR', 'paper').executions.map((item) => item.id)).toEqual([
        execution.id,
      ])
      expect(backend.executions).toEqual([execution, unknown])
    },
  )

  it('applies the same timestamp policy to streamed execution events', () => {
    const unknown = { ...execution, id: 'untimed-execution', timestamp: '' }
    const event = toTradingEvent(
      { type: 'executions', executions: [unknown, execution], timestamp: execution.timestamp },
      'IBKR',
      'paper',
    )
    expect(event).toEqual({
      type: 'executions',
      executions: [
        expect.objectContaining({ id: execution.id, time: Date.parse(execution.timestamp) }),
      ],
    })
  })

  it('streams an empty execution list when every broker time is unknown', () => {
    const event = toTradingEvent(
      {
        type: 'executions',
        executions: [{ ...execution, timestamp: '' }],
        timestamp: execution.timestamp,
      },
      'IBKR',
      'paper',
    )
    expect(event).toEqual({ type: 'executions', executions: [] })
  })
})
