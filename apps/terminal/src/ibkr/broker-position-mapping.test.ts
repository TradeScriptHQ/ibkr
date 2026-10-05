import { describe, expect, it } from 'vitest'
import { toTradingEvent, toTradingState } from './broker-mapping.js'
import type { BackendPosition, BackendState } from './types.js'

const position: BackendPosition = {
  id: 'synthetic-position',
  accountId: 'synthetic-account',
  symbol: {
    symbol: 'SYNTHETIC',
    canonicalSymbol: 'IBKR:500',
    assetClass: 'stock',
    currency: 'USD',
  },
  quantity: 2,
  avgCost: 10,
  markPrice: 12,
  marketValue: 24,
  unrealizedPnl: 3,
  realizedPnl: -1,
  pnlCurrency: 'EUR',
}

function stateWith(positions: BackendPosition[]): BackendState {
  return {
    connectionStatus: 'connected',
    activeAccountId: position.accountId,
    accounts: [{ id: position.accountId, label: 'Synthetic account', currency: 'GBP' }],
    orders: [],
    positions,
    executions: [],
    messages: [],
    diagnostics: [],
    quotes: [],
    updatedAt: '2026-09-30T14:30:00.000Z',
  }
}

describe('broker position P&L currency at the public SDK boundary', () => {
  it('preserves broker P&L currency separately from instrument prices and account currency', () => {
    const state = toTradingState(stateWith([position]), 'IBKR', 'paper')
    expect(state.positions[0]).toMatchObject({
      id: position.id,
      currency: 'USD',
      pnlCurrency: 'EUR',
      unrealizedPnl: 3,
      realizedPnl: -1,
      customFields: { pnlCurrency: 'EUR', marketValue: 24 },
    })
    expect(state.accounts[0]?.currency).toBe('GBP')
  })

  it('keeps streamed P&L currency corrections in the public position field', () => {
    const event = toTradingEvent(
      {
        type: 'positions',
        positions: [{ ...position, pnlCurrency: 'CHF', unrealizedPnl: 4 }],
        timestamp: '2026-09-30T14:31:00.000Z',
      },
      'IBKR',
      'paper',
    )
    expect(event).toMatchObject({
      type: 'positions',
      positions: [{ currency: 'USD', pnlCurrency: 'CHF', unrealizedPnl: 4 }],
    })
  })

  it('leaves missing P&L currency unknown instead of borrowing instrument or account currency', () => {
    const unknown = { ...position, pnlCurrency: undefined }
    const mapped = toTradingState(stateWith([unknown]), 'IBKR', 'paper').positions[0]
    expect(mapped?.currency).toBe('USD')
    expect(mapped).not.toHaveProperty('pnlCurrency')
    const event = toTradingEvent(
      { type: 'positions', positions: [unknown], timestamp: '2026-09-30T14:32:00.000Z' },
      'IBKR',
      'paper',
    )
    if (event?.type !== 'positions') throw new Error('Missing mapped position event')
    expect(event.positions[0]).not.toHaveProperty('pnlCurrency')
  })
})
