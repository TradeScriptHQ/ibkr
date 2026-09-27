import type { Contract } from '@stoqey/ib'
import { describe, expect, it } from 'vitest'
import {
  fromIbSymbol,
  normalizeBrokerSymbol,
  resolveAssetClass,
  toIbContract,
} from '../src/ibkr/contracts.js'
import { fromIbPosition } from '../src/ibkr/order-conversion.js'
import { validateDraft } from '../src/ibkr/order-validation.js'

describe('IBKR security type identity', () => {
  it.each([
    ['FUT', 'futures'],
    ['FOP', 'futures-option'],
    ['IND', 'index'],
    ['BOND', 'bond'],
    ['FUND', 'fund'],
    ['WAR', 'warrant'],
    ['CFD', 'cfd'],
    ['CMDTY', 'commodity'],
    ['CONTFUT', 'continuous-futures'],
    ['NEWTYPE', 'unknown'],
  ])('preserves %s readback and refuses an implicit stock order', (secType, assetClass) => {
    const contract = {
      symbol: 'TEST',
      secType,
      conId: 123,
      exchange: 'TESTVENUE',
      currency: 'EUR',
      localSymbol: 'TEST SEP',
      lastTradeDateOrContractMonth: '20260918',
      multiplier: 10,
    } as Contract
    const symbol = fromIbSymbol(contract)
    expect(symbol).toMatchObject({
      assetClass,
      currency: 'EUR',
      exchange: 'TESTVENUE',
      contractIdentity: { securityType: secType, conId: 123, expiry: '20260918', multiplier: 10 },
    })
    expect(normalizeBrokerSymbol(symbol)).toEqual(symbol)
    if (['FUT', 'IND', 'FUND', 'BOND', 'WAR', 'CFD', 'CMDTY'].includes(secType)) {
      expect(toIbContract(symbol)).toMatchObject({ secType, conId: 123 })
    } else expect(toIbContract.bind(null, symbol)).toThrow(/Unsupported instrument type/)
    expect(
      validateDraft({
        symbol,
        side: 'buy',
        type: 'limit',
        duration: 'day',
        quantity: 1,
        limitPrice: 1,
      }),
    ).toMatchObject({ accepted: ['FUT', 'BOND', 'WAR', 'CFD', 'CMDTY'].includes(secType) })
  })

  it('does not let a familiar venue override an explicit unsupported class', () => {
    expect(resolveAssetClass('futures', 'IDEALPRO')).toBe('futures')
    expect(resolveAssetClass('bond', 'PAXOS')).toBe('bond')
    expect(() => toIbContract({ symbol: 'TEST', assetClass: 'bond', exchange: 'PAXOS' })).toThrow(
      /exact IBKR contract/,
    )
  })

  it('keeps different expiries distinct in portfolio readback', () => {
    const base = {
      symbol: 'ES',
      secType: 'FUT',
      exchange: 'CME',
      currency: 'USD',
      multiplier: 50,
    } as Contract
    const september = fromIbPosition(
      'paper-test',
      { ...base, conId: 1, lastTradeDateOrContractMonth: '20260918' },
      1,
      5000,
    )
    const december = fromIbPosition(
      'paper-test',
      { ...base, conId: 2, lastTradeDateOrContractMonth: '20261218' },
      1,
      5000,
    )
    expect(september.id).not.toEqual(december.id)
    expect(september.symbol.contractIdentity?.expiry).toBe('20260918')
    expect(december.symbol.contractIdentity?.expiry).toBe('20261218')
  })
})
