import { describe, expect, it } from 'vitest'
import {
  BASELINE_PRODUCT_CAPABILITIES,
  BASELINE_TRADING_CAPABILITIES,
  MARKET_DATA_CAPABILITY_FAMILIES,
  TRADESCRIPT_SDK_PRODUCTS,
  TRADING_CONTROLLER_OPERATION_IDS,
} from '../src/index.js'

describe('TradeScript capability baseline', () => {
  it('contains every current SDK product exactly once', () => {
    expect(TRADESCRIPT_SDK_PRODUCTS).toHaveLength(26)
    expect(new Set(TRADESCRIPT_SDK_PRODUCTS).size).toBe(TRADESCRIPT_SDK_PRODUCTS.length)
  })

  it('contains every current trading operation exactly once', () => {
    expect(TRADING_CONTROLLER_OPERATION_IDS).toHaveLength(54)
    expect(new Set(TRADING_CONTROLLER_OPERATION_IDS).size).toBe(
      TRADING_CONTROLLER_OPERATION_IDS.length,
    )
  })

  it('classifies every trading operation without a pending placeholder', () => {
    expect(BASELINE_TRADING_CAPABILITIES).toHaveLength(TRADING_CONTROLLER_OPERATION_IDS.length)
    expect(
      BASELINE_TRADING_CAPABILITIES.filter(({ disposition }) => disposition === 'pending-sdk'),
    ).toEqual([])
    expect(
      BASELINE_TRADING_CAPABILITIES.filter(({ disposition }) => disposition === 'implemented'),
    ).toHaveLength(42)
    for (const capability of BASELINE_TRADING_CAPABILITIES) {
      if (capability.disposition !== 'implemented') {
        expect(capability.reason, capability.id).toEqual(expect.any(String))
      }
    }
  })

  it('classifies only mobile and prediction markets as not applicable', () => {
    expect(
      BASELINE_PRODUCT_CAPABILITIES.filter(({ disposition }) => disposition === 'not-applicable')
        .map(({ id }) => id)
        .sort(),
    ).toEqual(['mobileChart', 'predictionMarketOrderTicket'])
  })

  it('keeps every market-data family unique', () => {
    expect(new Set(MARKET_DATA_CAPABILITY_FAMILIES).size).toBe(
      MARKET_DATA_CAPABILITY_FAMILIES.length,
    )
  })
})
