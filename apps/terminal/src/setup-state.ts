import {
  MARKET_DATA_CAPABILITY_FAMILIES,
  type SystemStatusResponse,
  TRADESCRIPT_SDK_PRODUCTS,
  TRADING_CONTROLLER_OPERATION_IDS,
} from '@ibkr-terminal/contracts'

export const TERMINAL_COVERAGE = Object.freeze({
  applicableProducts: TRADESCRIPT_SDK_PRODUCTS.filter((product) => product !== 'mobileChart')
    .length,
  tradingOperations: TRADING_CONTROLLER_OPERATION_IDS.length,
  marketDataFamilies: MARKET_DATA_CAPABILITY_FAMILIES.length,
})

export function requiredReadiness(status: SystemStatusResponse): {
  readonly ready: number
  readonly total: number
} {
  const required = status.requirements.filter(({ requiredForTrading }) => requiredForTrading)
  return {
    ready: required.filter(({ state }) => state === 'ready').length,
    total: required.length,
  }
}
