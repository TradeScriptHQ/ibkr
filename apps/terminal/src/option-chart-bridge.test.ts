import type { TradingOptionContract } from '@tradescript/pro/sdk'
import { expect, it, vi } from 'vitest'
import { createLocalSimulation, MOCK_PROVIDER } from './mock/local-simulation.js'
import { createOptionChartBridge } from './option-chart-bridge.js'

const contract: TradingOptionContract = {
  underlying: 'QQQ',
  underlyingSymbolInfo: { ticker: 'QQQ', canonicalSymbol: 'IBKR:320227571', type: 'stock' },
  symbol: 'provider-display-name',
  expiration: '2026-10-08',
  strike: 758,
  right: 'call',
  multiplier: 100,
  exchange: 'SMART',
  currency: 'USD',
}

it('charts the broker-qualified ID rather than deriving identity from display text', async () => {
  const { broker } = createLocalSimulation()
  broker.resolveOptionContract = vi.fn(async () => ({
    contract: { ...contract, brokerContractId: 928264058 },
  }))
  const symbol = await createOptionChartBridge(broker, 'ibkr').toChartSelection(contract)
  expect(broker.resolveOptionContract).toHaveBeenCalledWith({ contract })
  expect(symbol).toMatchObject({
    canonicalSymbol: 'IBKR:928264058',
    brokerSymbol: 'IBKR:928264058',
    type: 'option',
    instrument: {
      underlyingSymbolInfo: contract.underlyingSymbolInfo,
      expiration: '2026-10-08',
      strike: 758,
      right: 'call',
      brokerContractId: 928264058,
    },
  })
})

it('rejects an unqualified IBKR contract instead of charting a guessed symbol', async () => {
  const { broker } = createLocalSimulation()
  broker.resolveOptionContract = vi.fn(async () => ({ contract }))
  await expect(createOptionChartBridge(broker, 'ibkr').toChartSelection(contract)).rejects.toThrow(
    'exact option contract identity',
  )
})

it('uses the simulator-owned option identity and available synthetic quote', async () => {
  const { broker, datafeed } = createLocalSimulation({ now: () => Date.UTC(2026, 9, 7) })
  if (!datafeed.resolveSymbol || !datafeed.getQuotes)
    throw new Error('Missing simulator market API')
  const underlying = await datafeed.resolveSymbol('AAPL')
  const selected = {
    ...contract,
    underlying: 'AAPL',
    underlyingSymbolInfo: underlying,
    strike: 200,
  }
  const symbol = await createOptionChartBridge(broker, 'mock').toChartSelection(selected)
  const resolved = await datafeed.resolveSymbol(symbol)
  expect(resolved.provider).toBe(MOCK_PROVIDER)
  expect(resolved.canonicalSymbol).toMatch(/^mock-option:/)
  expect((await datafeed.getQuotes({ symbols: [resolved] }))[0]?.status).toBe('ok')
})
