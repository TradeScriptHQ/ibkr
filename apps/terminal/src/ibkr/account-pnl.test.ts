import { afterEach, expect, it, vi } from 'vitest'
import { createIbkrHttpBrokerAdapter } from './http-broker-adapter'

afterEach(() => vi.unstubAllGlobals())

it.each([
  { realizedPnl: 12, unrealizedPnl: -5, expected: 7 },
  { realizedPnl: -12, unrealizedPnl: 5, expected: -7 },
  { realizedPnl: 0, unrealizedPnl: 0, expected: 0 },
  { realizedPnl: 12, unrealizedPnl: undefined, expected: undefined },
  { realizedPnl: undefined, unrealizedPnl: undefined, expected: undefined },
])('maps account P&L without treating missing data as zero: %j', async (values) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          connectionStatus: 'connected',
          activeAccountId: 'DU123',
          accounts: [
            {
              id: 'DU123',
              label: 'Paper',
              currency: 'EUR',
              realizedPnl: values.realizedPnl,
              unrealizedPnl: values.unrealizedPnl,
              dailyPnl: 99,
            },
          ],
          orders: [],
          positions: [],
          executions: [],
          messages: [],
        }),
      ),
    ),
  )
  const broker = createIbkrHttpBrokerAdapter({ executionEnvironment: 'paper' })
  const state = await broker.getState()
  expect(state.accounts[0]?.pnl).toEqual({
    currency: 'EUR',
    ...(values.expected === undefined ? {} : { totalPnl: values.expected }),
    ...(values.realizedPnl === undefined ? {} : { realizedPnl: values.realizedPnl }),
    ...(values.unrealizedPnl === undefined ? {} : { unrealizedPnl: values.unrealizedPnl }),
  })
  expect(state.accounts[0]?.customFields?.dailyPnl).toBe(99)
})
