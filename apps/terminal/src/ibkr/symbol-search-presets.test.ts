import { expect, it } from 'vitest'
import { IBKR_DEFAULT_SYMBOLS, IBKR_SAVED_VIEWS } from './symbol-search-presets.js'

it('lists default contracts for the stock, forex and crypto tabs as exact IBKR search rows', () => {
  expect(new Set(IBKR_DEFAULT_SYMBOLS.map((symbol) => symbol.type))).toEqual(
    new Set(['stock', 'forex', 'crypto']),
  )
  expect(IBKR_DEFAULT_SYMBOLS.find((symbol) => symbol.ticker === 'AAPL')).toMatchObject({
    canonicalSymbol: 'IBKR:265598',
    brokerSymbol: 'AAPL',
    exchange: 'SMART',
    listedExchange: 'NASDAQ',
    currency: 'USD',
    type: 'stock',
  })
  expect(IBKR_DEFAULT_SYMBOLS.find((symbol) => symbol.ticker === 'BTC')).toMatchObject({
    canonicalSymbol: 'IBKR:479624278',
    exchange: 'PAXOS',
  })
  expect(IBKR_DEFAULT_SYMBOLS.find((symbol) => symbol.ticker === 'EURUSD')).toMatchObject({
    exchange: 'IDEALPRO',
    currency: 'USD',
    type: 'forex',
  })
  const identities = IBKR_DEFAULT_SYMBOLS.map((symbol) => symbol.canonicalSymbol ?? symbol.ticker)
  expect(new Set(identities).size).toBe(identities.length)
  expect(IBKR_SAVED_VIEWS.map((view) => view.id)).toEqual([
    'cme-futures',
    'usd-stocks',
    'forecast-contracts',
  ])
})
