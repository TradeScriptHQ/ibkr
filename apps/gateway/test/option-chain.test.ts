import { EventEmitter } from 'node:events'
import { type Contract, EventName, type IBApi, SecType } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

function fixture(
  last = 316.22,
  options: { expirations?: string[]; validStrikes?: (expiration: string) => number[] } = {},
) {
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  store.upsertQuote({
    symbol: { symbol: 'AAPL', exchange: 'NASDAQ', currency: 'USD', assetClass: 'stock' },
    last,
    status: 'delayed',
    timestamp: new Date().toISOString(),
  })
  const ib = new EventEmitter()
  const active = new Map<number, Contract>()
  let autoTick = true
  const reqMktData = vi.fn((reqId: number, contract: Contract) => {
    active.set(reqId, contract)
    if (autoTick) {
      ib.emit(EventName.tickPrice, reqId, 1, 1)
      ib.emit(EventName.tickPrice, reqId, 2, 2)
    }
  })
  const cancelMktData = vi.fn((reqId: number) => active.delete(reqId))
  const reqMarketRule = vi.fn((marketRuleId: number) =>
    queueMicrotask(() =>
      ib.emit(EventName.marketRule, marketRuleId, [
        { lowEdge: 0, increment: 0.005 },
        { lowEdge: 1, increment: 0.01 },
      ]),
    ),
  )
  Object.assign(ib, { reqMktData, cancelMktData, reqMarketRule })
  const service = new IbkrService(createBridgeConfig(loadGatewayConfig({})), store, ib as IBApi)
  // Stub only the TWS boundary; exercise the real catalog and quote selection.
  const boundary = service as unknown as {
    requestContractDetails: (contract: Contract) => Promise<unknown[]>
    requestSecDefOptParams: () => Promise<unknown[]>
  }
  const strikes = Array.from({ length: 81 }, (_, i) => 200 + i * 2.5)
  const expirations = options.expirations ?? ['20260909']
  const requestContractDetails = vi
    .spyOn(boundary, 'requestContractDetails')
    .mockImplementation(async (contract) => {
      if (contract.secType === SecType.STK) {
        return [
          {
            contract: {
              conId: 265598,
              symbol: 'AAPL',
              secType: SecType.STK,
              exchange: 'SMART',
              currency: 'USD',
            },
          },
        ]
      }
      const expiration = String(contract.lastTradeDateOrContractMonth)
      const validStrikes = options.validStrikes?.(expiration) ?? strikes
      return validStrikes.flatMap((strike) =>
        (['C', 'P'] as const).map((right) => ({
          minTick: 0.005,
          validExchanges: 'SMART,CBOE',
          marketRuleIds: '26,26',
          contract: {
            conId: Number(
              `${expiration.slice(-4)}${Math.round(strike * 10)}${right === 'P' ? 1 : 0}`,
            ),
            symbol: 'AAPL',
            localSymbol: `AAPL ${expiration} ${right} ${strike}`,
            tradingClass: 'AAPL',
            secType: SecType.OPT,
            lastTradeDateOrContractMonth: expiration,
            strike,
            right,
            multiplier: 100,
            exchange: 'SMART',
            currency: 'USD',
          },
        })),
      )
    })
  vi.spyOn(boundary, 'requestSecDefOptParams').mockResolvedValue([
    {
      exchange: 'CBOE',
      tradingClass: 'AAPL',
      multiplier: '100',
      expirations,
      strikes,
    },
    {
      exchange: 'SMART',
      tradingClass: 'AAPL',
      multiplier: '100',
      expirations,
      strikes,
    },
  ])
  return {
    service,
    strikes,
    requestContractDetails,
    active,
    reqMktData,
    reqMarketRule,
    cancelMktData,
    pauseInitialTicks: () => {
      autoTick = false
    },
    tick: (bid: number, ask: number) => {
      for (const reqId of active.keys()) {
        ib.emit(EventName.tickPrice, reqId, 1, bid)
        ib.emit(EventName.tickPrice, reqId, 2, ask)
      }
    },
    modelGreeks: () => {
      for (const reqId of active.keys()) {
        ib.emit(
          EventName.tickOptionComputation,
          reqId,
          13,
          0,
          0.24,
          0.52,
          1.45,
          0,
          0.031,
          0.087,
          -0.14,
          last,
        )
      }
    },
  }
}

const request = { underlying: 'AAPL', expirations: ['2026-09-09'], maxQuoteContracts: 40 }

describe('option strike catalog and quote budget', () => {
  it('quotes a requested window larger than 40 contracts', async () => {
    const { service, reqMktData } = fixture()
    const chain = await service.getOptionChain({ ...request, maxQuoteContracts: 80 })
    expect(reqMktData).toHaveBeenCalledTimes(80)
    expect(chain.expirations[0].contracts.filter((row) => row.bid !== undefined)).toHaveLength(80)
  })

  it('quotes the full selected expiry when no window is requested', async () => {
    const { service, reqMktData } = fixture()
    const chain = await service.getOptionChain({
      underlying: request.underlying,
      expirations: request.expirations,
    })
    const rows = chain.expirations[0].contracts
    expect(rows.length).toBeGreaterThan(40)
    expect(reqMktData).toHaveBeenCalledTimes(rows.length)
    expect(rows.every((row) => row.bid !== undefined)).toBe(true)
  })

  it('preserves higher and lower strikes while quoting around the underlying price', async () => {
    const { service, strikes } = fixture()
    const chain = await service.getOptionChain(request)
    expect(chain.exchange).toBe('SMART')
    const rows = chain.expirations[0].contracts
    expect([...new Set(rows.map((r) => r.contract.strike))]).toEqual(strikes)
    expect(rows.every((row) => row.contract.brokerContractId != null)).toBe(true)
    expect(rows.every((row) => row.contract.priceStep === 0.005)).toBe(true)
    expect(rows.every((row) => row.contract.priceIncrements?.[1]?.increment === 0.01)).toBe(true)
    const quoted = rows.filter((r) => r.bid !== undefined).map((r) => r.contract.strike)
    expect(quoted).toEqual(expect.arrayContaining([307.5, 310, 312.5, 315, 317.5, 320]))
    expect(Math.min(...quoted)).toBe(290)
    expect(Math.max(...quoted)).toBe(337.5)
  })

  it('refreshes quotes within the catalog cache lifetime', async () => {
    const { service, tick } = fixture()
    const first = await service.getOptionChain(request)
    tick(3, 4)
    const next = await service.getOptionChain(request)
    expect(first.expirations[0].contracts.find((r) => r.bid !== undefined)?.bid).toBe(1)
    expect(next.expirations[0].contracts.find((r) => r.bid !== undefined)?.bid).toBe(3)
  })

  it('pushes TWS option ticks without another chain request', async () => {
    const { service, tick } = fixture()
    const listener = vi.fn()
    const stream = await service.subscribeOptionChain(request, listener)

    tick(3, 4)
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(stream.initial.expirations[0].contracts.some((row) => row.bid === 1)).toBe(true)
    expect(listener).toHaveBeenCalled()
    const latest = listener.mock.calls.at(-1)?.[0]
    expect(latest.expirations[0].contracts.some((row: { bid?: number }) => row.bid === 3)).toBe(
      true,
    )
    stream.unsubscribe()
  })

  it('pushes TWS model Greeks with the streamed option quotes', async () => {
    const { service, modelGreeks } = fixture()
    const listener = vi.fn()
    const stream = await service.subscribeOptionChain(request, listener)

    modelGreeks()
    await new Promise((resolve) => setTimeout(resolve, 25))

    const latest = listener.mock.calls.at(-1)?.[0]
    expect(latest.expirations[0].contracts).toContainEqual(
      expect.objectContaining({
        impliedVolatility: 0.24,
        delta: 0.52,
        gamma: 0.031,
        theta: -0.14,
        vega: 0.087,
      }),
    )
    stream.unsubscribe()
  })

  it('keeps overlapping quotes when the window moves down before new TWS ticks arrive', async () => {
    const { service, requestContractDetails, reqMktData, cancelMktData, pauseInitialTicks, tick } =
      fixture()
    await service.getOptionChain({ ...request, centerPrice: 317.5 })
    expect(reqMktData).toHaveBeenCalledTimes(40)
    pauseInitialTicks()
    const shifted = await service.getOptionChain({ ...request, centerPrice: 315 })
    const quoted = shifted.expirations[0].contracts.filter((r) => r.bid !== undefined)
    expect(quoted).toHaveLength(38)
    expect(quoted.map((r) => r.contract.strike)).toContain(315)
    expect(reqMktData).toHaveBeenCalledTimes(42)
    expect(cancelMktData).toHaveBeenCalledTimes(2)
    tick(3, 4)
    const refreshed = await service.getOptionChain({ ...request, centerPrice: 315 })
    expect(refreshed.expirations[0].contracts.filter((r) => r.bid === 3)).toHaveLength(40)
    expect(reqMktData).toHaveBeenCalledTimes(42)
    expect(
      requestContractDetails.mock.calls.filter(([contract]) => contract.secType === SecType.OPT),
    ).toHaveLength(1)
  })

  it('centers an explicit row window using the delayed underlying quote', async () => {
    const { service } = fixture()
    const chain = await service.getOptionChain({ ...request, quoteWindowRows: 20 })
    const strikes = [...new Set(chain.expirations[0].contracts.map((r) => r.contract.strike))]
    expect(strikes).toHaveLength(20)
    expect(strikes[0]).toBe(290)
    expect(strikes.at(-1)).toBe(337.5)
  })

  it('honors an explicit center and bounds without coupling rows to the quote budget', async () => {
    const { service, reqMktData } = fixture()
    const chain = await service.getOptionChain({
      ...request,
      centerPrice: 370,
      quoteWindowRows: 10,
      maxQuoteContracts: 4,
      minStrike: 350,
      maxStrike: 390,
    })
    const rows = chain.expirations[0].contracts
    expect(rows).toHaveLength(20)
    expect(reqMktData).toHaveBeenCalledTimes(4)
    expect(rows.filter((r) => r.bid !== undefined).map((r) => r.contract.strike)).toEqual([
      367.5, 367.5, 370, 370,
    ])
  })

  it('publishes only expiration and strike pairs returned as real contracts by IBKR', async () => {
    const { service } = fixture(316.22, {
      validStrikes: (expiration) =>
        expiration === '20261016' ? Array.from({ length: 17 }, (_, index) => 280 + index * 5) : [],
      expirations: ['20261016'],
    })
    const chain = await service.getOptionChain({
      underlying: 'AAPL',
      expirations: ['2026-10-16'],
      centerPrice: 314,
      quoteWindowRows: 20,
      maxQuoteContracts: 40,
    })
    const rows = chain.expirations[0].contracts
    expect([...new Set(rows.map((row) => row.contract.strike))]).toEqual(
      Array.from({ length: 17 }, (_, index) => 280 + index * 5),
    )
    expect(rows.some((row) => row.contract.strike === 302.5)).toBe(false)
    expect(rows.every((row) => row.contract.brokerContractId != null)).toBe(true)
  })

  it('returns all IBKR expirations while qualifying only the nearest initial catalog', async () => {
    const { service, requestContractDetails, reqMktData } = fixture(316.22, {
      expirations: ['20260909', '20260911', '20260918'],
    })
    const chain = await service.getOptionChain({ underlying: 'AAPL', maxQuoteContracts: 40 })
    expect(chain.expirations.map((item) => item.expiration)).toEqual([
      '2026-09-09',
      '2026-09-11',
      '2026-09-18',
    ])
    expect(chain.expirations[0].contracts.length).toBeGreaterThan(0)
    expect(chain.expirations.slice(1).every((item) => item.contracts.length === 0)).toBe(true)
    expect(reqMktData).not.toHaveBeenCalled()
    expect(
      requestContractDetails.mock.calls.filter(([contract]) => contract.secType === SecType.OPT),
    ).toHaveLength(1)
  })
})
