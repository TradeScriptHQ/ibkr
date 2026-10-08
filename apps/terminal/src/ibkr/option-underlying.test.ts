import { expect, it } from 'vitest'
import { toSymbolInfo } from './datafeed-mapping.js'

it('carries the qualified underlying identity on a resolved option chart symbol', () => {
  expect(
    toSymbolInfo({
      ticker: 'QQQ   261008C00758000',
      brokerSymbol: 'IBKR:928264058',
      type: 'option',
      currency: 'USD',
      option: {
        kind: 'option',
        underlying: 'QQQ',
        expiration: '2026-10-08',
        strike: 758,
        right: 'call',
        brokerContractId: 928264058,
        underlyingSymbolInfo: {
          ticker: 'QQQ',
          canonicalSymbol: 'IBKR:320227571',
          brokerSymbol: 'IBKR:320227571',
          type: 'stock',
          exchange: 'SMART',
          primaryExchange: 'NASDAQ',
          currency: 'USD',
        },
      },
    }),
  ).toMatchObject({
    brokerSymbol: 'IBKR:928264058',
    instrument: {
      kind: 'option',
      underlying: 'QQQ',
      underlyingSymbolInfo: {
        ticker: 'QQQ',
        brokerSymbol: 'IBKR:320227571',
        canonicalSymbol: 'IBKR:320227571',
        type: 'stock',
        exchange: 'SMART',
        listedExchange: 'NASDAQ',
        currency: 'USD',
      },
    },
  })
})
