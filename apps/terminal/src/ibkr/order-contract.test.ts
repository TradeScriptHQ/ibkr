import type { TradingOrderContext, TradingOrderDraft } from '@tradescript/pro/sdk'
import { expect, it } from 'vitest'
import { toBackendDraft, toBackendDuration, toTradingDuration } from './types'

const draft: TradingOrderDraft = {
  symbol: {
    ticker: 'AAPL',
    exchange: 'SMART',
    listedExchange: 'NASDAQ',
    type: 'stock',
    currency: 'USD',
  },
  side: 'buy',
  type: 'market',
  quantity: 1,
  duration: { type: 'day' },
}

it('preserves the USD instrument when a EUR account previews or submits it', () => {
  const context: TradingOrderContext = { symbol: draft.symbol, accountId: 'DU123', currency: 'EUR' }
  expect(toBackendDraft(draft, context).symbol).toMatchObject({
    symbol: 'AAPL',
    exchange: 'SMART',
    primaryExchange: 'NASDAQ',
    currency: 'USD',
    sourceSymbol: { currency: 'USD' },
  })
})

it('preserves a non-USD instrument in a USD account', () => {
  const instrument = { ...draft.symbol, ticker: 'SAP', currency: 'EUR', exchange: 'IBIS' }
  expect(
    toBackendDraft({ ...draft, symbol: instrument }, { symbol: instrument, currency: 'USD' }).symbol
      .currency,
  ).toBe('EUR')
})

it('does not guess an instrument currency from the account', () => {
  const { currency: _currency, ...instrument } = draft.symbol
  expect(() =>
    toBackendDraft({ ...draft, symbol: instrument }, { symbol: instrument, currency: 'EUR' }),
  ).toThrow('instrument currency')
})

it('preserves SDK built-in and IBKR custom time-in-force values', () => {
  expect(toBackendDuration({ type: 'ioc', label: 'IOC' })).toBe('ioc')
  expect(toBackendDuration({ type: 'custom', value: 'OPG', label: 'OPG' })).toBe('opg')
  expect(
    toBackendDuration({ type: 'custom', value: 'OVERNIGHT + DAY', label: 'OVERNIGHT + DAY' }),
  ).toBe('overnight-day')
  expect(toBackendDuration({ type: 'custom', value: 'OVERNIGHT', label: 'OVERNIGHT' })).toBe(
    'overnight',
  )
})

it('maps bridge-only durations back to SDK custom durations', () => {
  expect(toTradingDuration('opg')).toEqual({ type: 'custom', value: 'opg', label: 'OPG' })
  expect(toTradingDuration('overnight-day')).toEqual({
    type: 'custom',
    value: 'overnight-day',
    label: 'OVERNIGHT + DAY',
  })
})

it('maps the Iceberg visibility choice to IBKR displaySize transport', () => {
  expect(
    toBackendDraft({
      ...draft,
      quantity: 100,
      customFields: { orderVisibility: 'iceberg', displaySize: 25 },
    }),
  ).toMatchObject({
    quantity: 100,
    displaySize: 25,
    hidden: false,
  })
})

it('does not send a stale displayed quantity when Show all is selected', () => {
  expect(
    toBackendDraft({
      ...draft,
      quantity: 100,
      customFields: { orderVisibility: 'visible', displaySize: 25 },
    }).displaySize,
  ).toBeUndefined()
})

it('maps an SDK cash-denominated order without inventing crypto units', () => {
  const crypto = { ...draft.symbol, ticker: 'BTC', exchange: 'PAXOS', type: 'crypto' as const }
  expect(
    toBackendDraft({
      ...draft,
      symbol: crypto,
      type: 'market',
      duration: { type: 'ioc' },
      quantity: 0,
      cashQuantity: 25,
    }),
  ).toMatchObject({
    symbol: { symbol: 'BTC', exchange: 'PAXOS', currency: 'USD', assetClass: 'crypto' },
    type: 'market',
    duration: 'ioc',
    quantity: 0,
    cashQuantity: 25,
  })
})
