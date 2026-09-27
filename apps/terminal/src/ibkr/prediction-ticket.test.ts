import { expect, it, vi } from 'vitest'
import { get, getQuotes } from './datafeed-requests.js'
import { loadForecastOutcomes } from './prediction-ticket.js'

vi.mock('./datafeed-requests.js', () => ({ get: vi.fn(), getQuotes: vi.fn() }))

it('loads exact paired ForecastEx outcomes and retains their native execution type', async () => {
  const prediction = {
    kind: 'prediction-contract',
    eventId: 'FF:20260916',
    marketId: 'FF:20260916:3.375',
    eventTitle: 'Fed funds',
    marketTitle: 'Fed funds threshold',
    priceConvention: 'probability',
    payout: { amount: 1, currency: 'USD' },
  }
  vi.mocked(get).mockImplementation(async (_base, path) => {
    if (path.includes('opposing-outcome')) return { contractIdentity: { conId: 2 } }
    const yes = path.includes('IBKR%3A1')
    return [
      {
        symbol: {
          ticker: yes ? 'YES' : 'NO',
          canonicalSymbol: yes ? 'IBKR:1' : 'IBKR:2',
          brokerSymbol: yes ? 'IBKR:1' : 'IBKR:2',
          type: 'event-contract',
          exchange: 'FORECASTX',
          currency: 'USD',
          prediction: {
            ...prediction,
            outcomeId: yes ? 'IBKR:1' : 'IBKR:2',
            outcomeLabel: yes ? 'Yes' : 'No',
          },
        },
      },
    ]
  })
  vi.mocked(getQuotes).mockResolvedValue([])
  const outcomes = await loadForecastOutcomes({
    ticker: 'YES',
    brokerSymbol: 'IBKR:1',
    currency: 'USD',
  })
  expect(
    outcomes.map(({ symbol, tone }) => [
      symbol.brokerSymbol,
      symbol.type,
      symbol.instrument.outcomeLabel,
      tone,
    ]),
  ).toEqual([
    ['IBKR:1', 'event-contract', 'Yes', 'positive'],
    ['IBKR:2', 'event-contract', 'No', 'negative'],
  ])
  expect(get).toHaveBeenCalledWith(
    '/api/v1/ibkr',
    expect.stringContaining('/contracts/opposing-outcome?'),
  )
})
