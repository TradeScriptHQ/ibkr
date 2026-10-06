import type { AgentRiskLimits } from '@ibkr-terminal/contracts'
import type {
  Quote,
  RiskPolicyEnvelope,
  RiskPolicyUtilizationSource,
  SdkSymbolInfo,
  TradingCurrencyConversion,
  TradingEvent,
  TradingOrder,
  TradingOrderDraft,
  TradingPosition,
  TradingState,
} from '@tradescript/pro/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createLocalSimulation,
  type LocalSimulation,
  MOCK_ACCOUNT_ID,
  MOCK_PROVIDER,
} from './mock/local-simulation.js'
import { createConnectionRiskAuthority, riskPositionInstrumentId } from './risk.js'

afterEach(() => vi.restoreAllMocks())

const stockPosition: TradingPosition = {
  id: 'DU1234567:265598',
  accountId: 'DU1234567',
  symbol: { ticker: 'AAPL', brokerSymbol: 'AAPL', currency: 'USD', type: 'stock' },
  side: 'long',
  quantity: 100,
}

const optionPosition: TradingPosition = {
  id: 'DU1234567:917428525',
  accountId: 'DU1234567',
  symbol: { ticker: 'AAPL', brokerSymbol: 'AAPL', currency: 'USD', type: 'option' },
  optionContract: {
    underlying: 'AAPL',
    underlyingSymbolInfo: {
      ticker: 'AAPL',
      brokerSymbol: 'AAPL',
      currency: 'USD',
      type: 'stock',
    },
    expiration: '2026-09-09',
    strike: 317.5,
    right: 'call',
    multiplier: 100,
    exchange: 'SMART',
    currency: 'USD',
    brokerContractId: 917428525,
  },
  side: 'long',
  quantity: 1,
}

const optionContractFixture = optionPosition.optionContract
if (!optionContractFixture) throw new Error('Option fixture requires an exact option contract.')

it('keeps stock and option utilization identities unique for the same underlying', () => {
  expect(riskPositionInstrumentId(stockPosition)).toBe('AAPL')
  expect(riskPositionInstrumentId(optionPosition)).toBe('option:917428525')
  expect(new Set([stockPosition, optionPosition].map(riskPositionInstrumentId)).size).toBe(2)
})

it('uses the selected live policy and timestamps decisions after asynchronous quote acquisition', async () => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const { createConnectionRiskAuthority } = await import('./risk.js')
  let policy: unknown
  const sdk = {
    trading: {
      createRiskPolicyController(options: { policy: unknown }) {
        policy = options.policy
        return { destroy() {} }
      },
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[0]
  const broker = {
    async getState() {
      return {
        accounts: [{ id: 'U-test', name: 'Test', currency: 'USD', customFields: { dailyPnl: 0 } }],
        connectionStatus: 'connected',
        positions: [],
        orders: [],
        ordersHistory: [],
        activeAccountId: 'U-test',
      }
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[1]
  const datafeed = {
    async getQuotes() {
      await Promise.resolve()
      now += 25
      return [
        { symbol: stockPosition.symbol, bid: 10, ask: 11, status: 'ok', timestamp: Date.now() },
      ]
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[2]
  const limits = {
    maxOrderQuantity: 100,
    maxOrderNotional: 1000,
    maxPositionQuantity: 100,
    maxPositionNotional: 1000,
    maxDailyLoss: 100,
    maxOrdersPerMinute: 10,
    maxEstimatedSlippageBps: 100,
    maxMarketDataAgeMs: 1000,
    maxLeverage: 2,
    maxUnprotectedPositionQuantity: 100,
  }
  const authority = await createConnectionRiskAuthority(
    sdk,
    broker,
    datafeed,
    { enabled: true, autonomyMode: 'paper-auto', allowedAccountIds: ['U-test'], limits },
    'live',
  )
  expect(policy).toMatchObject({ autonomyMode: 'bounded-live-auto', limits })
  const request = await authority.requests.placeOrder?.({
    controlId: 'trading.placeOrder',
    draft: { symbol: stockPosition.symbol, side: 'buy', type: 'limit', quantity: 1, price: 10 },
    context: { symbol: stockPosition.symbol, accountId: 'U-test' },
  })
  expect(request).toMatchObject({
    executionEnvironment: 'live',
    accountId: 'U-test',
    quantity: 1,
    requestedAt: now,
    marketDataAsOf: now,
  })
  authority.destroy()
})

it('counts an exact restored option without invented legs against its option position', async () => {
  const { createConnectionRiskAuthority } = await import('./risk.js')
  const symbol = {
    ticker: 'AAPL',
    brokerSymbol: 'IBKR:917428525',
    canonicalSymbol: 'IBKR:917428525',
    currency: 'USD',
    exchange: 'SMART',
    type: 'option' as const,
  }
  const { optionContract: _knownOptionContract, ...nativePosition } = optionPosition
  expect(riskPositionInstrumentId({ ...nativePosition, symbol })).toBe('option:917428525')
  const broker = {
    async getTradingSymbolInfo(context: { symbol: SdkSymbolInfo }) {
      return { symbol: context.symbol, contractMultiplier: 100 }
    },
    async getState() {
      return {
        accounts: [
          {
            id: 'paper-options',
            name: 'Paper options',
            currency: 'USD',
            customFields: { dailyPnl: 0 },
          },
        ],
        connectionStatus: 'connected',
        ordersHistory: [],
        activeAccountId: 'paper-options',
        positions: [
          {
            ...optionPosition,
            accountId: 'paper-options',
            quantity: 3,
            side: 'short',
            marketPrice: 2,
          },
        ],
        orders: [
          {
            id: 'restored-option',
            accountId: 'paper-options',
            symbol,
            side: 'sell',
            type: 'limit',
            price: 2,
            quantity: 5,
            status: 'working',
            createdAt: Date.now(),
          },
          {
            id: 'poisoned-option',
            accountId: 'paper-options',
            symbol: { ...symbol, brokerSymbol: 'IBKR:123' },
            side: 'sell',
            type: 'limit',
            price: 2,
            quantity: 5,
            status: 'working',
            createdAt: Date.now(),
          },
        ],
      }
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[1]
  const sdk = {
    trading: { createRiskPolicyController: () => ({ destroy() {} }) },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[0]
  const datafeed = {
    async getQuotes() {
      return [{ symbol, bid: 2, ask: 2.01, status: 'ok', timestamp: Date.now() }]
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[2]
  const authority = await createConnectionRiskAuthority(sdk, broker, datafeed, {
    enabled: true,
    autonomyMode: 'paper-auto',
    allowedAccountIds: ['paper-options'],
    limits: {
      maxOrderQuantity: 100,
      maxOrderNotional: 1000,
      maxPositionQuantity: 100,
      maxPositionNotional: 1000,
      maxDailyLoss: 100,
      maxOrdersPerMinute: 10,
      maxEstimatedSlippageBps: 100,
      maxMarketDataAgeMs: 1000,
      maxLeverage: 2,
      maxUnprotectedPositionQuantity: 100,
    },
  })
  try {
    const request = await authority.requests.modifyOrder?.({
      controlId: 'trading.modifyOrder',
      orderId: 'restored-option',
      patch: { quantity: 2 },
      context: { symbol, accountId: 'paper-options' },
    })
    expect(request).toMatchObject({
      instrumentId: 'option:917428525',
      quantity: 2,
      projectedPositionQuantity: 5,
      notional: 400,
      projectedPositionNotional: 1000,
    })
    await expect(
      authority.requests.modifyOrder?.({
        controlId: 'trading.modifyOrder',
        orderId: 'poisoned-option',
        patch: { quantity: 2 },
        context: { symbol, accountId: 'paper-options' },
      }),
    ).rejects.toThrow(/exact, matching.*option/)
  } finally {
    authority.destroy()
  }
})

const riskLimits = {
  maxOrderQuantity: 100,
  maxOrderNotional: 1000,
  maxPositionQuantity: 100,
  maxPositionNotional: 1000,
  maxDailyLoss: 100,
  maxOrdersPerMinute: 10,
  maxEstimatedSlippageBps: 100,
  maxMarketDataAgeMs: 1000,
  maxLeverage: 2,
  maxUnprotectedPositionQuantity: 100,
}

const exactOptionSymbol: SdkSymbolInfo = {
  ticker: 'AAPL',
  brokerSymbol: 'IBKR:917428525',
  canonicalSymbol: 'IBKR:917428525',
  currency: 'USD',
  exchange: 'SMART',
  type: 'option',
}

async function riskHarness(
  options: {
    positions?: TradingPosition[]
    orders?: TradingOrder[]
    multiplier?: number
    rulesSymbol?: SdkSymbolInfo
    quote?: Partial<Quote>
    accounts?: TradingState['accounts']
    ordersHistory?: TradingOrder[]
    limits?: Partial<AgentRiskLimits>
    conversion?: TradingCurrencyConversion
    simulation?: LocalSimulation
    atomicRisk?: boolean
    monetaryValueAvailable?: boolean
  } = {},
) {
  let utilization: RiskPolicyUtilizationSource | undefined
  let policy: RiskPolicyEnvelope | undefined
  const sdk = {
    trading: {
      createRiskPolicyController(input: {
        policy: RiskPolicyEnvelope
        utilization: RiskPolicyUtilizationSource
      }) {
        policy = input.policy
        utilization = input.utilization
        return {
          destroy() {},
          ...(options.atomicRisk
            ? { requestCapabilities: { atomicLegExposures: true, cashBudget: true } }
            : {}),
        }
      },
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[0]
  const getTradingSymbolInfo = vi.fn(async (context: { symbol: SdkSymbolInfo }) => ({
    symbol: options.rulesSymbol ?? context.symbol,
    monetaryValueAvailable: options.monetaryValueAvailable,
    monetaryValueUnavailableReason:
      options.monetaryValueAvailable === false
        ? 'Native quote monetary units are unavailable.'
        : undefined,
    ...(options.multiplier === undefined ? {} : { contractMultiplier: options.multiplier }),
    ...(options.conversion === undefined ? {} : { accountCurrencyConversion: options.conversion }),
  }))
  let state: TradingState = {
    connectionStatus: 'connected',
    executions: [],
    accounts: options.accounts ?? [
      { id: 'paper-risk', name: 'Paper risk', currency: 'USD', customFields: { dailyPnl: 0 } },
    ],
    positions: options.positions ?? [],
    orders: options.orders ?? [],
    ordersHistory: options.ordersHistory ?? [],
    activeAccountId: 'paper-risk',
  }
  let subscriber: ((event: TradingEvent) => void) | undefined
  const getState = vi.fn(async () => state)
  const broker = {
    getTradingSymbolInfo,
    getState,
    subscribe(callback: (event: TradingEvent) => void) {
      subscriber = callback
      return () => {
        subscriber = undefined
      }
    },
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[1]
  const getQuotes = vi.fn(async (request: { symbols: SdkSymbolInfo[] }) => [
    {
      symbol: request.symbols[0],
      bid: 2.25,
      ask: 2.25,
      status: 'ok',
      timestamp: Date.now(),
      ...options.quote,
    },
  ])
  const datafeed = {
    getQuotes,
  } as unknown as Parameters<typeof createConnectionRiskAuthority>[2]
  const accountId = options.simulation ? MOCK_ACCOUNT_ID : 'paper-risk'
  const authority = await createConnectionRiskAuthority(
    sdk,
    options.simulation?.broker ?? broker,
    options.simulation?.datafeed ?? datafeed,
    {
      enabled: true,
      autonomyMode: 'paper-auto',
      allowedAccountIds: [accountId],
      limits: { ...riskLimits, ...options.limits },
    },
  )
  return {
    authority,
    policy,
    utilization,
    getQuotes,
    getTradingSymbolInfo,
    getState,
    updateState(next: Partial<TradingState>) {
      state = { ...state, ...next }
    },
    refresh(event: TradingEvent = { type: 'positions', positions: state.positions }) {
      subscriber?.(event)
    },
    place(draft: TradingOrderDraft) {
      return authority.requests.placeOrder?.({
        controlId: 'trading.placeOrder',
        draft,
        context: { symbol: draft.symbol, accountId },
      })
    },
  }
}

it('transports disabled quantity caps to the SDK while retaining monetary and other safety limits', async () => {
  const position = { ...stockPosition, accountId: 'paper-risk', quantity: 200, marketPrice: 2.25 }
  const limits: AgentRiskLimits = {
    ...riskLimits,
    maxOrderQuantity: null,
    maxPositionQuantity: null,
    maxUnprotectedPositionQuantity: null,
    maxGrossExposure: 1500,
  }
  const harness = await riskHarness({ positions: [position], limits })
  try {
    const { maxGrossExposure: _hostGrossCap, ...sdkLimits } = limits
    expect(harness.policy).toEqual({
      autonomyMode: 'paper-auto',
      accounts: { mode: 'allow-list', values: ['paper-risk'] },
      instruments: { mode: 'all' },
      sessions: { mode: 'all' },
      sides: { mode: 'all' },
      orderTypes: { mode: 'all' },
      limits: sdkLimits,
    })
    expect(
      await harness.place({
        symbol: position.symbol,
        side: 'buy',
        type: 'market',
        quantity: 200,
      }),
    ).toMatchObject({
      quantity: 200,
      notional: 450,
      projectedPositionQuantity: 400,
      projectedPositionNotional: 900,
      estimatedSlippageBps: 0,
    })
    expect(
      await harness.authority.requests.modifyPosition?.({
        controlId: 'trading.modifyPosition',
        positionId: position.id,
        context: { symbol: position.symbol, accountId: position.accountId },
        patch: { stopLoss: null },
      }),
    ).toMatchObject({
      kind: 'position-protection-change',
      positionQuantity: 200,
      projectedUnprotectedQuantity: 200,
    })
  } finally {
    harness.authority.destroy()
  }
})

it('keeps the host gross monetary cap active when all quantity caps are disabled', async () => {
  const harness = await riskHarness({
    positions: [{ ...stockPosition, accountId: 'paper-risk', marketPrice: 2.25 }],
    limits: {
      maxOrderQuantity: null,
      maxPositionQuantity: null,
      maxUnprotectedPositionQuantity: null,
      maxGrossExposure: 674,
    },
  })
  try {
    await expect(
      harness.place({
        symbol: stockPosition.symbol,
        side: 'buy',
        type: 'market',
        quantity: 200,
      }),
    ).rejects.toThrow('Projected gross account exposure exceeds the configured risk limit.')
  } finally {
    harness.authority.destroy()
  }
})

it.each(['broker-owned', 'sdk-projected'])(
  'uses explicit synthetic account/history facts and exact %s option premium for mock risk',
  async (projection) => {
    const simulation = createLocalSimulation()
    const symbol: SdkSymbolInfo = {
      ticker: 'AAPL',
      canonicalSymbol: 'mock:AAPL',
      brokerSymbol: 'AAPL',
      exchange: 'SMART',
      currency: 'USD',
      type: 'stock',
      provider: MOCK_PROVIDER,
    }
    const resolved = await simulation.broker.resolveOptionContract?.({
      accountId: MOCK_ACCOUNT_ID,
      contract: {
        underlying: 'AAPL',
        underlyingSymbolInfo: symbol,
        expiration: '2026-10-16',
        strike: 200,
        right: 'call',
        multiplier: 100,
        exchange: 'SMART',
        currency: 'USD',
        symbol: 'AAPL-2026-10-16-C-200',
      },
    })
    if (!resolved) throw new Error('Synthetic option authority missing')
    const contract =
      projection === 'sdk-projected'
        ? {
            ...resolved.contract,
            customFields: { keys: ['provider', 'synthetic'], valuesOmitted: true },
          }
        : resolved.contract
    const { authority, place } = await riskHarness({ simulation })
    const draft: TradingOrderDraft = {
      symbol,
      side: 'buy',
      type: 'market',
      quantity: 1,
      optionLegs: [{ contract, side: 'buy', positionEffect: 'open', quantity: 1, price: 2.5 }],
    }
    try {
      const stock = await place({ symbol, side: 'buy', type: 'market', quantity: 1 })
      expect(stock).toMatchObject({ accountId: MOCK_ACCOUNT_ID, notional: 200.05 })
      const buy = await place(draft)
      expect(buy).toMatchObject({
        instrumentId: 'mock-option:AAPL-2026-10-16-C-200',
      })
      if (buy?.kind !== 'order-exposure') throw new Error('Expected exact option exposure')
      expect(buy.notional).toBeCloseTo(251)
      expect(buy.projectedPositionNotional).toBeCloseTo(251)
      await expect(
        place({
          ...draft,
          optionLegs: [
            {
              contract: { ...contract, brokerContractId: 'unregistered-contract' },
              side: 'buy',
              positionEffect: 'open',
              quantity: 1,
              price: 2.5,
            },
          ],
        }),
      ).rejects.toThrow('prices are unavailable')
      expect((await simulation.broker.getState()).executions).toEqual([])
      await simulation.broker.placeOrder(draft, {
        accountId: MOCK_ACCOUNT_ID,
        symbol,
        lastPrice: 200,
      })
      const sell = await place({
        ...draft,
        side: 'sell',
        optionLegs: [
          {
            contract,
            side: 'sell',
            positionEffect: 'close',
            quantity: 1,
            price: 3,
          },
        ],
      })
      expect(sell).toMatchObject({
        projectedPositionQuantity: 0,
        projectedPositionNotional: 0,
        notional: 300,
      })
      expect((await simulation.broker.getState()).accounts[0]?.customFields?.dailyPnl).toBe(-1)
    } finally {
      authority.destroy()
    }
  },
)

it('does not authorize a declared mock option identity on an IBKR account', async () => {
  const symbol: SdkSymbolInfo = {
    ticker: 'AAPL',
    type: 'stock',
    provider: MOCK_PROVIDER,
    currency: 'USD',
  }
  const { authority, place, getQuotes } = await riskHarness({
    accounts: [
      {
        id: 'paper-risk',
        name: 'IBKR',
        brokerName: 'IBKR',
        currency: 'USD',
        customFields: { dailyPnl: 0 },
      },
    ],
  })
  try {
    await expect(
      place({
        symbol,
        side: 'buy',
        type: 'market',
        quantity: 1,
        optionLegs: [
          {
            contract: {
              underlying: 'AAPL',
              underlyingSymbolInfo: symbol,
              expiration: '2026-10-16',
              strike: 200,
              right: 'call',
              multiplier: 100,
              route: 'LOCAL',
              currency: 'USD',
              brokerContractId: 'declared-mock-id',
              customFields: { provider: MOCK_PROVIDER, synthetic: true },
            },
            side: 'buy',
            positionEffect: 'open',
            quantity: 1,
          },
        ],
      }),
    ).rejects.toThrow('not authorized by this broker account')
    expect(getQuotes).not.toHaveBeenCalled()
  } finally {
    authority.destroy()
  }
})

it.each([
  ['native option', exactOptionSymbol, 100, 2.25, 450, 1125],
  [
    'native futures option',
    { ...exactOptionSymbol, ticker: 'ES', exchange: 'CME' },
    50,
    2.25,
    225,
    562.5,
  ],
  [
    'native futures',
    { ...exactOptionSymbol, ticker: 'ES', exchange: 'CME', type: 'futures' },
    50,
    5000,
    500000,
    1250000,
  ],
  ['ordinary stock', stockPosition.symbol, undefined, 2.25, 4.5, 11.25],
] as const)(
  'uses monetary contract sizing for %s orders and projected positions',
  async (_label, symbol, multiplier, price, notional, projectedPositionNotional) => {
    const harness = await riskHarness({
      ...(multiplier === undefined ? {} : { multiplier }),
      quote: { bid: price, ask: price },
      positions: [
        {
          id: 'position',
          accountId: 'paper-risk',
          symbol,
          side: 'short',
          quantity: 3,
          marketPrice: price,
          customFields: { marketValue: -3 * price * (multiplier ?? 1) },
        },
      ],
    })
    try {
      const request = await harness.place({ symbol, side: 'sell', type: 'market', quantity: 2 })
      expect(request).toMatchObject({
        notional,
        projectedPositionQuantity: 5,
        projectedPositionNotional,
      })
      expect(harness.getTradingSymbolInfo).toHaveBeenCalledWith(expect.objectContaining({ symbol }))
    } finally {
      harness.authority.destroy()
    }
  },
)

it('prices a single option leg on its exact contract and uses its actual side and quantity', async () => {
  const harness = await riskHarness({
    positions: [
      { ...optionPosition, accountId: 'paper-risk', quantity: 3, side: 'short', marketPrice: 2.25 },
    ],
  })
  try {
    const request = await harness.place({
      symbol: stockPosition.symbol,
      side: 'buy',
      type: 'limit',
      quantity: 2,
      price: 0.01,
      optionLegs: [
        {
          contract: optionContractFixture,
          side: 'sell',
          positionEffect: 'open',
          quantity: 2,
          ratio: 1,
          price: 2.25,
        },
      ],
    })
    expect(request).toMatchObject({
      instrumentId: 'option:917428525',
      side: 'sell',
      quantity: 2,
      notional: 450,
      projectedPositionQuantity: 5,
      projectedPositionNotional: 1125,
    })
    expect(harness.getQuotes).toHaveBeenCalledWith({ symbols: [exactOptionSymbol] })
    expect(harness.getTradingSymbolInfo).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: exactOptionSymbol }),
    )
  } finally {
    harness.authority.destroy()
  }
})

it('selects strategy legs once when the same option is also listed in optionLegs', async () => {
  const harness = await riskHarness()
  const leg = {
    contract: optionContractFixture,
    side: 'sell' as const,
    positionEffect: 'open' as const,
    quantity: 2,
    ratio: 1,
  }
  try {
    expect(
      await harness.place({
        symbol: stockPosition.symbol,
        side: 'buy',
        type: 'market',
        quantity: 2,
        optionLegs: [leg],
        strategyLegs: [{ ...leg, instrument: 'option' }],
      }),
    ).toMatchObject({ instrumentId: 'option:917428525', quantity: 2, notional: 450 })
  } finally {
    harness.authority.destroy()
  }
})

it('uses changed contract quantity and price when modifying a single option leg', async () => {
  const harness = await riskHarness({
    positions: [
      {
        ...optionPosition,
        accountId: 'paper-risk',
        quantity: 3,
        side: 'short',
        marketPrice: 2.25,
      },
    ],
    orders: [
      {
        id: 'legged-order',
        accountId: 'paper-risk',
        symbol: stockPosition.symbol,
        side: 'sell',
        type: 'limit',
        quantity: 5,
        price: 2.25,
        status: 'working',
        createdAt: Date.now(),
        optionLegs: [
          {
            contract: optionContractFixture,
            side: 'sell',
            positionEffect: 'open',
            quantity: 5,
            ratio: 1,
            price: 2.25,
          },
        ],
      },
    ],
  })
  try {
    const request = await harness.authority.requests.modifyOrder?.({
      controlId: 'trading.modifyOrder',
      orderId: 'legged-order',
      patch: { quantity: 2, price: 3 },
      context: { symbol: stockPosition.symbol, accountId: 'paper-risk' },
    })
    expect(request).toMatchObject({
      instrumentId: 'option:917428525',
      side: 'sell',
      quantity: 2,
      notional: 600,
      projectedPositionQuantity: 5,
      projectedPositionNotional: 1500,
    })
    expect(harness.getQuotes).toHaveBeenCalledWith({ symbols: [exactOptionSymbol] })
  } finally {
    harness.authority.destroy()
  }
})

it.each(['identity', 'multiplier', 'ratio', 'quantity'] as const)(
  'blocks a single option leg with unavailable or inconsistent %s',
  async (missing) => {
    const harness = await riskHarness()
    const contract = { ...optionContractFixture }
    if (missing === 'identity') delete contract.brokerContractId
    if (missing === 'multiplier') contract.multiplier = 0
    try {
      await expect(
        harness.place({
          symbol: stockPosition.symbol,
          side: 'buy',
          type: 'market',
          quantity: 2,
          optionLegs: [
            {
              contract,
              side: 'buy',
              positionEffect: 'open',
              quantity: missing === 'quantity' ? 3 : 2,
              ratio: missing === 'ratio' ? 2 : 1,
            },
          ],
        }),
      ).rejects.toThrow(/identity|multiplier|quantities|ratios/i)
      expect(harness.getQuotes).not.toHaveBeenCalled()
    } finally {
      harness.authority.destroy()
    }
  },
)

it.each(['option', 'futures'] as const)(
  'blocks missing provider sizing for native %s orders',
  async (type) => {
    const harness = await riskHarness()
    try {
      await expect(
        harness.place({
          symbol: { ...exactOptionSymbol, type },
          side: 'buy',
          type: 'market',
          quantity: 2,
        }),
      ).rejects.toThrow(/multiplier|sizing/i)
    } finally {
      harness.authority.destroy()
    }
  },
)

it('blocks native sizing reported for a different contract', async () => {
  const harness = await riskHarness({
    multiplier: 100,
    rulesSymbol: { ...exactOptionSymbol, canonicalSymbol: 'IBKR:123', brokerSymbol: 'IBKR:123' },
  })
  try {
    await expect(
      harness.place({ symbol: exactOptionSymbol, side: 'buy', type: 'market', quantity: 2 }),
    ).rejects.toThrow(/different|matching|identity/i)
  } finally {
    harness.authority.destroy()
  }
})

it('does not reduce existing option exposure by using a tiny order limit instead of its quote', async () => {
  const harness = await riskHarness({
    multiplier: 100,
    positions: [
      {
        id: 'position',
        accountId: 'paper-risk',
        symbol: exactOptionSymbol,
        side: 'short',
        quantity: 3,
        customFields: { marketValue: -675 },
      },
    ],
  })
  try {
    expect(
      await harness.place({
        symbol: exactOptionSymbol,
        side: 'sell',
        type: 'limit',
        quantity: 2,
        price: 0.01,
      }),
    ).toMatchObject({
      notional: 450,
      projectedPositionQuantity: 5,
      projectedPositionNotional: 1125,
    })
  } finally {
    harness.authority.destroy()
  }
})

it('blocks an option quote for the underlying instead of the exact contract', async () => {
  const harness = await riskHarness({ multiplier: 100, quote: { symbol: stockPosition.symbol } })
  try {
    await expect(
      harness.place({ symbol: exactOptionSymbol, side: 'buy', type: 'market', quantity: 2 }),
    ).rejects.toThrow(/different|matching|identity/i)
  } finally {
    harness.authority.destroy()
  }
})

it.each(['options', 'mixed'] as const)(
  'blocks %s strategies because one SDK request cannot represent per-leg exposure',
  async (kind) => {
    const harness = await riskHarness()
    const leg = {
      contract: optionContractFixture,
      side: 'sell' as const,
      positionEffect: 'open' as const,
      quantity: 2,
      ratio: 1,
    }
    try {
      const draft: TradingOrderDraft = {
        symbol: stockPosition.symbol,
        side: 'buy',
        type: 'market',
        quantity: 2,
      }
      if (kind === 'options')
        draft.optionLegs = [leg, { ...leg, contract: { ...leg.contract, brokerContractId: 123 } }]
      else
        draft.strategyLegs = [
          { ...leg, instrument: 'option' },
          {
            instrument: 'equity',
            symbol: 'AAPL',
            symbolInfo: stockPosition.symbol,
            side: 'buy',
            positionEffect: 'open',
            quantity: 200,
            ratio: 100,
          },
        ]
      await expect(harness.place(draft)).rejects.toThrow(/multi-leg.*risk|per-leg.*exposure/i)
      expect(harness.getQuotes).not.toHaveBeenCalled()
    } finally {
      harness.authority.destroy()
    }
  },
)

it('uses public atomic capability for exact mixed constituent facts without netting premiums or units', async () => {
  const harness = await riskHarness({
    atomicRisk: true,
    positions: [
      { ...stockPosition, accountId: 'paper-risk', marketPrice: 2.25 },
      { ...optionPosition, accountId: 'paper-risk', marketPrice: 2.25 },
    ],
  })
  const draft: TradingOrderDraft = {
    symbol: stockPosition.symbol,
    side: 'buy',
    type: 'market',
    quantity: 2,
    strategyLegs: [
      {
        instrument: 'option',
        contract: optionContractFixture,
        side: 'sell',
        positionEffect: 'open',
        quantity: 2,
        ratio: 1,
      },
      {
        instrument: 'equity',
        symbol: 'AAPL',
        symbolInfo: stockPosition.symbol,
        side: 'buy',
        positionEffect: 'open',
        quantity: 200,
        ratio: 100,
      },
    ],
  }
  try {
    const request = await harness.place(draft)
    expect(request).toMatchObject({
      instrumentId: 'option:917428525',
      side: 'sell',
      quantity: 2,
      notional: 900,
      projectedPositionQuantity: 1,
      projectedPositionNotional: 225,
      legExposures: [
        {
          instrumentId: 'option:917428525',
          side: 'sell',
          quantity: 2,
          notional: 450,
          projectedPositionQuantity: 1,
          projectedPositionNotional: 225,
        },
        {
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 200,
          notional: 450,
          projectedPositionQuantity: 300,
          projectedPositionNotional: 675,
        },
      ],
    })
    expect(
      harness.getQuotes.mock.calls.map(
        ([input]) => input.symbols[0]?.canonicalSymbol ?? input.symbols[0]?.ticker,
      ),
    ).toEqual(['IBKR:917428525', 'AAPL'])
  } finally {
    harness.authority.destroy()
  }
})

it('rejects atomic combined gross exposure and an unavailable constituent before creating a request', async () => {
  const draft: TradingOrderDraft = {
    symbol: stockPosition.symbol,
    side: 'buy',
    type: 'market',
    quantity: 2,
    optionLegs: [
      {
        contract: optionContractFixture,
        side: 'buy',
        positionEffect: 'open',
        quantity: 2,
        ratio: 1,
      },
      {
        contract: { ...optionContractFixture, brokerContractId: 123 },
        side: 'sell',
        positionEffect: 'open',
        quantity: 2,
        ratio: 1,
      },
    ],
  }
  const gross = await riskHarness({ atomicRisk: true, limits: { maxGrossExposure: 899 } })
  try {
    await expect(gross.place(draft)).rejects.toThrow(/gross account exposure/)
  } finally {
    gross.authority.destroy()
  }
  const unavailable = await riskHarness({ atomicRisk: true })
  unavailable.getQuotes.mockImplementation(async (input) =>
    input.symbols[0]?.brokerSymbol === 'IBKR:123'
      ? []
      : [
          {
            symbol: input.symbols[0],
            bid: 2.25,
            ask: 2.25,
            status: 'ok',
            timestamp: Date.now(),
          },
        ],
  )
  try {
    await expect(unavailable.place(draft)).rejects.toThrow(/no quote/)
  } finally {
    unavailable.authority.destroy()
  }
})

it('retains authoritative option ratios and rejects duplicate atomic identities', async () => {
  const harness = await riskHarness({ atomicRisk: true })
  const leg = {
    contract: optionContractFixture,
    side: 'buy' as const,
    positionEffect: 'open' as const,
    quantity: 2,
    ratio: 2,
  }
  const draft: TradingOrderDraft = {
    symbol: stockPosition.symbol,
    side: 'buy',
    type: 'market',
    quantity: 1,
    optionLegs: [
      leg,
      { ...leg, contract: { ...leg.contract, brokerContractId: 123 }, quantity: 3, ratio: 3 },
    ],
  }
  try {
    expect(await harness.place(draft)).toMatchObject({
      notional: 1125,
      legExposures: [
        { instrumentId: 'option:917428525', quantity: 2 },
        { instrumentId: 'option:123', quantity: 3 },
      ],
    })
    await expect(harness.place({ ...draft, optionLegs: [leg, leg] })).rejects.toThrow(
      /identities must be unique/,
    )
  } finally {
    harness.authority.destroy()
  }
})

it.each([
  ['stock', stockPosition.symbol, undefined, undefined, 6.75],
  ['native option', exactOptionSymbol, undefined, 100, 675],
  ['native futures', { ...exactOptionSymbol, type: 'futures' }, undefined, 50, 337.5],
  ['typed option', optionPosition.symbol, optionPosition.optionContract, undefined, 675],
] as const)(
  'uses truthful fallback sizing for %s position utilization',
  async (_label, symbol, optionContract, multiplier, absoluteNotional) => {
    const harness = await riskHarness({
      ...(multiplier === undefined ? {} : { multiplier }),
      positions: [
        {
          id: 'position',
          accountId: 'paper-risk',
          symbol,
          side: 'short',
          quantity: 3,
          marketPrice: 2.25,
          ...(optionContract === undefined ? {} : { optionContract }),
        },
      ],
    })
    try {
      expect(harness.utilization?.getCurrentUtilization().positions).toEqual([
        expect.objectContaining({ absoluteNotional, absoluteQuantity: 3 }),
      ])
    } finally {
      harness.authority.destroy()
    }
  },
)

it('honors provider market value without requiring unavailable position multiplier', async () => {
  const harness = await riskHarness({
    positions: [
      {
        id: 'position',
        accountId: 'paper-risk',
        symbol: exactOptionSymbol,
        side: 'short',
        quantity: 3,
        marketPrice: 2.25,
        customFields: { marketValue: -812 },
      },
    ],
  })
  try {
    expect(harness.utilization?.getCurrentUtilization().positions).toEqual([
      expect.objectContaining({ absoluteNotional: 812 }),
    ])
    expect(harness.getTradingSymbolInfo).not.toHaveBeenCalled()
  } finally {
    harness.authority.destroy()
  }
})

it('blocks risk authority initialization when a native position has no truthful fallback sizing', async () => {
  await expect(
    riskHarness({
      positions: [
        {
          id: 'position',
          accountId: 'paper-risk',
          symbol: exactOptionSymbol,
          side: 'short',
          quantity: 3,
          marketPrice: 2.25,
        },
      ],
    }),
  ).rejects.toThrow(/multiplier|sizing/i)
})

it.each([
  ['delayed', { status: 'delayed' }],
  ['frozen', { metadata: { marketDataType: 'frozen' } }],
  ['closed', { status: 'closed' }],
  ['previous close only', { bid: 0, ask: 0, previousClose: 2.25 }],
] as const)('blocks %s data from authorizing a monetary risk request', async (_label, quote) => {
  const harness = await riskHarness({ quote })
  try {
    await expect(
      harness.place({ symbol: stockPosition.symbol, side: 'buy', type: 'market', quantity: 1 }),
    ).rejects.toThrow(/current|live|price|quote/i)
  } finally {
    harness.authority.destroy()
  }
})

it('enforces the configured gross cap using other positions plus the projected exact position', async () => {
  const harness = await riskHarness({
    limits: { maxGrossExposure: 100 },
    positions: [
      {
        id: 'other-position',
        accountId: 'paper-risk',
        symbol: { ...stockPosition.symbol, ticker: 'MSFT', brokerSymbol: 'MSFT' },
        side: 'long',
        quantity: 1,
        customFields: { marketValue: 99 },
      },
    ],
  })
  try {
    await expect(
      harness.place({ symbol: stockPosition.symbol, side: 'buy', type: 'market', quantity: 1 }),
    ).rejects.toThrow(/gross.*exposure/i)
    expect(
      await harness.place({
        symbol: stockPosition.symbol,
        side: 'buy',
        type: 'limit',
        quantity: 0.1,
        price: 2.25,
      }),
    ).toMatchObject({ notional: 0.225 })
  } finally {
    harness.authority.destroy()
  }
})

it('uses completed orders in the trailing-minute count without counting an active/history duplicate twice', async () => {
  const order: TradingOrder = {
    id: 'completed',
    accountId: 'paper-risk',
    symbol: stockPosition.symbol,
    side: 'buy',
    type: 'market',
    quantity: 1,
    status: 'filled',
    createdAt: Date.now() - 5000,
  }
  const harness = await riskHarness({
    orders: [order],
    ordersHistory: [order, { ...order, id: 'cancelled', status: 'cancelled' }],
  })
  try {
    expect(harness.utilization?.getCurrentUtilization().accounts).toEqual([
      expect.objectContaining({ ordersInLastMinute: 2 }),
    ])
  } finally {
    harness.authority.destroy()
  }
})

it('bounds completed orders without a submission time by when they completed', async () => {
  const completed = (id: string, completedAgoMs: number): TradingOrder => ({
    id,
    accountId: 'paper-risk',
    symbol: stockPosition.symbol,
    side: 'sell',
    type: 'market',
    quantity: 1,
    status: 'filled',
    updatedAt: Date.now() - completedAgoMs,
  })
  const harness = await riskHarness({
    ordersHistory: [completed('recent', 5_000), completed('morning', 3_600_000)],
  })
  try {
    expect(harness.utilization?.getCurrentUtilization().accounts).toEqual([
      expect.objectContaining({ ordersInLastMinute: 1 }),
    ])
  } finally {
    harness.authority.destroy()
  }
})

it('does not replace unavailable broker daily PnL with a connection-time equity baseline', async () => {
  const harness = await riskHarness({
    accounts: [
      { id: 'paper-risk', name: 'Paper risk', currency: 'USD', balance: { equity: 1000 } },
    ],
  })
  try {
    await expect(
      harness.place({ symbol: stockPosition.symbol, side: 'buy', type: 'market', quantity: 1 }),
    ).rejects.toThrow(/account.*risk|daily.*PnL/i)
    harness.updateState({
      accounts: [
        {
          id: 'paper-risk',
          name: 'Paper risk',
          balance: { equity: 900 },
          currency: 'USD',
          customFields: { dailyPnl: -30 },
        },
      ],
    })
    harness.refresh()
    await vi.waitFor(() =>
      expect(harness.utilization?.getCurrentUtilization().accounts).toEqual([
        expect.objectContaining({ dailyLoss: 30 }),
      ]),
    )
    expect(
      await harness.place({
        symbol: stockPosition.symbol,
        side: 'buy',
        type: 'market',
        quantity: 1,
      }),
    ).toMatchObject({ quantity: 1 })
  } finally {
    harness.authority.destroy()
  }
})

it('rejects a draft account that conflicts with the execution context', async () => {
  const harness = await riskHarness()
  try {
    await expect(
      harness.authority.requests.placeOrder?.({
        controlId: 'trading.placeOrder',
        draft: {
          accountId: 'other-account',
          symbol: stockPosition.symbol,
          side: 'buy',
          type: 'market',
          quantity: 1,
        },
        context: { symbol: stockPosition.symbol, accountId: 'paper-risk' },
      }),
    ).rejects.toThrow(/account.*(conflict|match)/i)
  } finally {
    harness.authority.destroy()
  }
})

it('blocks guarded cash orders instead of inventing a contract quantity', async () => {
  const harness = await riskHarness()
  try {
    await expect(
      harness.place({
        symbol: { ticker: 'BTC', type: 'crypto', currency: 'USD' },
        side: 'buy',
        type: 'market',
        quantity: 0,
        cashQuantity: 100,
      }),
    ).rejects.toThrow(/cash.*risk|cash.*quantity/i)
  } finally {
    harness.authority.destroy()
  }
})

it('retains a refresh event received during an in-flight refresh and waits for the latest position facts', async () => {
  const harness = await riskHarness()
  let complete: ((state: TradingState) => void) | undefined
  const pending = new Promise<TradingState>((resolve) => {
    complete = resolve
  })
  harness.getState.mockImplementationOnce(() => pending)
  harness.refresh()
  await vi.waitFor(() => expect(harness.getState).toHaveBeenCalledTimes(2))
  harness.updateState({
    positions: [{ ...stockPosition, accountId: 'paper-risk', quantity: 3, marketPrice: 2.25 }],
  })
  harness.refresh()
  if (!complete) throw new Error('Refresh completion is required')
  complete({
    connectionStatus: 'connected',
    accounts: [{ id: 'paper-risk', name: 'Paper risk', customFields: { dailyPnl: 0 } }],
    orders: [],
    ordersHistory: [],
    positions: [],
    executions: [],
  })
  try {
    expect(
      await harness.place({
        symbol: stockPosition.symbol,
        side: 'buy',
        type: 'market',
        quantity: 1,
      }),
    ).toMatchObject({ projectedPositionQuantity: 4 })
    expect(harness.getState).toHaveBeenCalledTimes(3)
  } finally {
    harness.authority.destroy()
  }
})

it('blocks stale position exposure after a failed refresh and recovers only after new broker facts', async () => {
  const harness = await riskHarness()
  harness.getState.mockRejectedValueOnce(new Error('Broker facts unavailable'))
  harness.refresh()
  try {
    await expect(
      harness.place({ symbol: stockPosition.symbol, side: 'buy', type: 'market', quantity: 1 }),
    ).rejects.toThrow(/current broker.*unavailable/i)
    harness.updateState({
      positions: [{ ...stockPosition, accountId: 'paper-risk', quantity: 3, marketPrice: 2.25 }],
    })
    harness.refresh()
    expect(
      await harness.place({
        symbol: stockPosition.symbol,
        side: 'buy',
        type: 'market',
        quantity: 1,
      }),
    ).toMatchObject({ projectedPositionQuantity: 4 })
  } finally {
    harness.authority.destroy()
  }
})

it('ignores broker logs and fails a risk check whose broker facts never settle', async () => {
  const harness = await riskHarness()
  try {
    harness.refresh({
      type: 'log',
      entry: {
        id: 'fx-200',
        level: 'error',
        source: 'adapter',
        message: 'Error 200',
        time: Date.now(),
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.getState).toHaveBeenCalledTimes(1)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    harness.getState.mockImplementationOnce(() => new Promise<TradingState>(() => undefined))
    harness.refresh()
    const placed = expect(
      harness.place({ symbol: stockPosition.symbol, side: 'buy', type: 'market', quantity: 1 }),
    ).rejects.toThrow(/did not settle within 12 seconds/)
    await vi.advanceTimersByTimeAsync(12_000)
    await placed
  } finally {
    vi.useRealTimers()
    harness.authority.destroy()
  }
})

it('blocks an account rate calculation when an order timestamp is unavailable', async () => {
  const harness = await riskHarness({
    orders: [
      {
        id: 'unknown-time',
        accountId: 'paper-risk',
        symbol: stockPosition.symbol,
        side: 'buy',
        type: 'market',
        quantity: 1,
        status: 'working',
      },
    ],
  })
  try {
    await expect(
      harness.place({ symbol: stockPosition.symbol, side: 'buy', type: 'market', quantity: 1 }),
    ).rejects.toThrow(/account risk facts/i)
  } finally {
    harness.authority.destroy()
  }
})

it('blocks unlike currency units for every monetary risk limit even without a gross cap', async () => {
  const harness = await riskHarness()
  try {
    await expect(
      harness.place({
        symbol: { ...stockPosition.symbol, currency: 'EUR' },
        side: 'buy',
        type: 'market',
        quantity: 1,
      }),
    ).rejects.toThrow(/currency.*conversion|conversion.*unavailable/i)
  } finally {
    harness.authority.destroy()
  }
})

it('uses a typed provider conversion for native order and projected position money values', async () => {
  const symbol = { ...exactOptionSymbol, currency: 'EUR' }
  const harness = await riskHarness({
    multiplier: 100,
    conversion: {
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: 2,
      asOf: Date.now(),
      source: 'IBKR',
    },
    positions: [
      {
        id: 'option',
        accountId: 'paper-risk',
        symbol,
        side: 'short',
        quantity: 3,
        customFields: { marketValue: -675 },
      },
    ],
  })
  try {
    expect(harness.utilization?.getCurrentUtilization().positions).toEqual([
      expect.objectContaining({ absoluteNotional: 1350 }),
    ])
    expect(
      await harness.place({ symbol, side: 'sell', type: 'market', quantity: 2 }),
    ).toMatchObject({ notional: 900, projectedPositionNotional: 2250 })
  } finally {
    harness.authority.destroy()
  }
})

it.each(['reversed', 'zero', 'stale', 'future', 'unknown source'] as const)(
  'rejects a %s provider currency conversion',
  async (invalid) => {
    const conversion: TradingCurrencyConversion = {
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: 2,
      asOf: Date.now(),
      source: 'IBKR',
    }
    if (invalid === 'reversed') {
      conversion.fromCurrency = 'USD'
      conversion.toCurrency = 'EUR'
    }
    if (invalid === 'zero') conversion.rate = 0
    if (invalid === 'stale') conversion.asOf -= 1001
    if (invalid === 'future') conversion.asOf += 10_000
    if (invalid === 'unknown source') conversion.source = ''
    const harness = await riskHarness({ conversion })
    try {
      await expect(
        harness.place({
          symbol: { ...stockPosition.symbol, currency: 'EUR' },
          side: 'buy',
          type: 'market',
          quantity: 1,
        }),
      ).rejects.toThrow(/currency.*conversion|conversion.*unavailable/i)
    } finally {
      harness.authority.destroy()
    }
  },
)

it('blocks a foreign-currency position snapshot when the provider supplied no account conversion', async () => {
  await expect(
    riskHarness({
      positions: [
        {
          id: 'foreign-position',
          accountId: 'paper-risk',
          symbol: { ...stockPosition.symbol, currency: 'EUR' },
          side: 'long',
          quantity: 1,
          customFields: { marketValue: 10 },
        },
      ],
    }),
  ).rejects.toThrow(/currency.*conversion|conversion.*unavailable/i)
})

it('binds the risk data age to the oldest quote or provider conversion fact', async () => {
  const now = 2_000_000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const harness = await riskHarness({
    conversion: {
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: 2,
      asOf: now - 100,
      source: 'IBKR',
    },
  })
  try {
    expect(
      await harness.place({
        symbol: { ...stockPosition.symbol, currency: 'EUR' },
        side: 'buy',
        type: 'market',
        quantity: 1,
      }),
    ).toMatchObject({ notional: 4.5, marketDataAsOf: now - 100, requestedAt: now })
  } finally {
    harness.authority.destroy()
  }
})

it('enforces a gross cap after every foreign position and proposed trade is converted', async () => {
  const symbol = { ...stockPosition.symbol, currency: 'EUR' }
  const harness = await riskHarness({
    conversion: {
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: 2,
      asOf: Date.now(),
      source: 'IBKR',
    },
    limits: { maxGrossExposure: 100 },
    positions: [
      {
        id: 'other-foreign',
        accountId: 'paper-risk',
        symbol: { ...symbol, ticker: 'MSFT', brokerSymbol: 'MSFT' },
        side: 'long',
        quantity: 1,
        customFields: { marketValue: 49 },
      },
    ],
  })
  try {
    expect(harness.utilization?.getCurrentUtilization().positions).toEqual([
      expect.objectContaining({ absoluteNotional: 98 }),
    ])
    await expect(
      harness.place({ symbol, side: 'buy', type: 'market', quantity: 1 }),
    ).rejects.toThrow(/gross.*exposure/i)
  } finally {
    harness.authority.destroy()
  }
})

it('guards a full exact option reversal using the two-contract native operation and resulting short exposure', async () => {
  const position = {
    ...optionPosition,
    accountId: 'paper-risk',
    marketPrice: 2.25,
    symbol: {
      ...optionPosition.symbol,
      canonicalSymbol: 'IBKR:917428525',
      brokerSymbol: 'IBKR:917428525',
      exchange: 'SMART',
    },
  }
  const harness = await riskHarness({ positions: [position] })
  const request = await harness.authority.requests.reversePosition?.({
    controlId: 'trading.reversePosition',
    positionId: position.id,
    context: { symbol: position.symbol, accountId: position.accountId },
  })
  expect(request).toMatchObject({
    instrumentId: 'option:917428525',
    side: 'sell',
    quantity: 2,
    notional: 450,
    projectedPositionQuantity: 1,
    projectedPositionNotional: 225,
  })
  expect(harness.getQuotes).toHaveBeenCalledWith({
    symbols: [expect.objectContaining({ brokerSymbol: 'IBKR:917428525' })],
  })
  await expect(
    harness.authority.requests.reversePosition?.({
      controlId: 'trading.reversePosition',
      positionId: position.id,
      options: { quantity: 0.5 },
      context: { symbol: position.symbol, accountId: position.accountId },
    }),
  ).rejects.toThrow('Partial position reversal')
  await expect(
    harness.authority.requests.reversePosition?.({
      controlId: 'trading.reversePosition',
      positionId: position.id,
      context: { symbol: stockPosition.symbol, accountId: position.accountId },
    }),
  ).rejects.toThrow('Position identity')
  harness.authority.destroy()
})

it('evaluates exact replacement stop coverage and rejects unproven preserved coverage or foreign protection', async () => {
  const position = { ...stockPosition, accountId: 'paper-risk', marketPrice: 2.25 }
  const harness = await riskHarness({ positions: [position] })
  const intent = {
    controlId: 'trading.modifyPosition' as const,
    positionId: position.id,
    context: { symbol: position.symbol, accountId: position.accountId },
  }
  const stop: TradingOrderDraft = {
    symbol: position.symbol,
    side: 'sell',
    type: 'stop',
    quantity: 75,
    stopPrice: 2,
  }
  expect(
    await harness.authority.requests.modifyPosition?.({ ...intent, patch: { stopLoss: stop } }),
  ).toMatchObject({
    kind: 'position-protection-change',
    positionQuantity: 100,
    projectedUnprotectedQuantity: 25,
  })
  expect(
    await harness.authority.requests.modifyPosition?.({ ...intent, patch: { stopLoss: null } }),
  ).toMatchObject({ projectedUnprotectedQuantity: 100 })
  await expect(
    harness.authority.requests.modifyPosition?.({
      ...intent,
      patch: { takeProfit: { ...stop, type: 'limit', price: 3 } },
    }),
  ).rejects.toThrow('complete replacement')
  await expect(
    harness.authority.requests.modifyPosition?.({
      ...intent,
      patch: { stopLoss: { ...stop, side: 'buy' } },
    }),
  ).rejects.toThrow('Exact protective stop')
  await expect(
    harness.authority.requests.modifyPosition?.({
      ...intent,
      patch: { stopLoss: { ...stop, quantity: 101 } },
    }),
  ).rejects.toThrow('cannot exceed')
  harness.authority.destroy()
})

it.each(['stock', 'option'] as const)(
  'refuses %s exposure when native monetary units are explicitly unavailable',
  async (type) => {
    const harness = await riskHarness({ monetaryValueAvailable: false, multiplier: 100 })
    try {
      await expect(
        harness.place({
          symbol: { ...exactOptionSymbol, type },
          side: 'buy',
          type: 'market',
          quantity: 1,
        }),
      ).rejects.toThrow(/monetary units.*unavailable/iu)
      expect(harness.getQuotes).not.toHaveBeenCalled()
    } finally {
      harness.authority.destroy()
    }
  },
)
