import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { BrokerState, Order, OrderDraft } from '@ibkr-terminal/contracts'
import type { APIRequestContext, APIResponse, BrowserContext } from '@playwright/test'
import { guardBrokerRequests, guardBrowserMutations } from './broker-guards.js'
import { PAPER_OWNER_FIELD } from './paper-fill-recovery.js'
import { trackPaperOrders } from './paper-order-tracker.js'

const symbol = {
  symbol: 'IBKR:101',
  canonicalSymbol: 'IBKR:101',
  exchange: 'SMART',
  currency: 'USD',
  assetClass: 'stock',
  contractIdentity: { securityType: 'STK', conId: 101 },
}
const session = { csrfToken: 'synthetic', expiresAt: '', mutationHeaders: {} }
const order = (
  id: string,
  side: 'buy' | 'sell',
  filledQuantity: number,
  extra: Partial<Order> = {},
): Order => ({
  id,
  submittedAt: '2026-09-30T12:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
  symbol,
  accountId: 'paper-test',
  side,
  type: 'limit',
  duration: 'day',
  quantity: 4,
  filledQuantity,
  remainingQuantity: 0,
  status:
    (extra.filledQuantity ?? filledQuantity) === (extra.quantity ?? 4) ? 'filled' : 'cancelled',
  ...extra,
})
const response = (body: unknown, status = 200, path = '/api/v1/ibkr/state'): APIResponse =>
  ({
    status: () => status,
    url: () => `http://localhost${path}`,
    headers: () => ({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
    json: async () => body,
  }) as unknown as APIResponse

function harness(records: Order[]) {
  const context = new EventEmitter()
  const tracker = trackPaperOrders(context as unknown as BrowserContext, true)
  const closes: OrderDraft[] = [],
    cancelled: string[] = []
  const state = {
    orders: records.filter((o) => o.status === 'working'),
    ordersHistory: records.filter((o) => o.status !== 'working'),
  } as BrokerState
  const probe = {
    get: async () => response(state),
    delete: async (url: string) => {
      const id = url.split('/').at(-1)!
      cancelled.push(id)
      const found = state.orders.find((o) => o.id === id)!
      state.orders = state.orders.filter((o) => o.id !== id)
      state.ordersHistory!.push({ ...found, status: 'cancelled', remainingQuantity: 0 })
      return response({})
    },
    post: async (path: string, options: { data: { draft: OrderDraft } }) => {
      if (path.endsWith('/preview'))
        return response({ accepted: true, confirmId: 'synthetic-preview' })
      const draft = options.data.draft
      closes.push(draft)
      const filled = order(`cleanup-${closes.length}`, draft.side, draft.quantity, {
        ...draft,
        status: 'filled',
      })
      state.ordersHistory!.push(filled)
      return response({ order: filled }, 201, '/api/v1/ibkr/orders')
    },
  } as unknown as APIRequestContext
  return { tracker, closes, cancelled, state, probe, context }
}

for (const filled of [4, 1])
  test(`fallback reverses only the exact known ${filled}-unit owned fill`, async () => {
    const entry = order('entry', 'buy', filled)
    const h = harness([entry, order('unrelated', 'buy', 100, { quantity: 100 })])
    try {
      await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
      await h.tracker.cleanup(h.probe, session)
      assert.deepEqual(
        h.closes.map((d) => [d.side, d.quantity]),
        [['sell', filled]],
      )
      assert.deepEqual(h.cancelled, [])
    } finally {
      h.tracker.dispose()
    }
  })

test('fallback nets exact child exits and successful caller cleanup receipts', async () => {
  const entry = order('entry', 'buy', 4)
  const close = order('caller-close', 'sell', 1)
  const h = harness([
    entry,
    order('child', 'sell', 1, { parentId: 'entry' }),
    close,
    order('unrelated', 'sell', 10, { quantity: 10 }),
  ])
  try {
    for (const receipt of [entry, close])
      await h.tracker.recordResponse(
        response({ order: receipt }, 201, '/api/v1/ibkr/orders'),
        'POST',
      )
    await h.tracker.cleanup(h.probe, session)
    assert.deepEqual(
      h.closes.map((d) => [d.side, d.quantity]),
      [['sell', 2]],
    )
  } finally {
    h.tracker.dispose()
  }
})

test('fallback does not reverse a caller cleanup that already offset the exact fill', async () => {
  const entry = order('entry', 'buy', 4),
    close = order('caller-close', 'sell', 4)
  const h = harness([entry, close, order('unrelated', 'buy', 50, { quantity: 50 })])
  try {
    for (const receipt of [entry, close])
      await h.tracker.recordResponse(
        response({ order: receipt }, 201, '/api/v1/ibkr/orders'),
        'POST',
      )
    await h.tracker.cleanup(h.probe, session)
    assert.deepEqual(h.closes, [])
    assert.deepEqual(h.cancelled, [])
  } finally {
    h.tracker.dispose()
  }
})

function tagged(h: ReturnType<typeof harness>, entry: Order, headers: Record<string, string> = {}) {
  const prepared = h.tracker.prepareRequest(
    '/api/v1/ibkr/orders',
    'POST',
    { draft: entry, expectedExecutionEnvironment: 'paper' },
    headers,
  )
  const draft = (prepared.body as { draft: OrderDraft }).draft
  entry.customFields = draft.customFields
  return prepared
}

test('direct API intent is registered and marked before dispatch; a lost response recovers only that marker', async () => {
  const h = harness([order('unrelated', 'buy', 100, { quantity: 100 })])
  const client = {
    post: async (_url: string, options: { data: { draft: OrderDraft } }) => {
      const draft = options.data.draft
      assert.equal(typeof draft.customFields?.[PAPER_OWNER_FIELD], 'string')
      h.state.ordersHistory!.push(
        order('accepted-without-receipt', 'buy', 2, { ...draft, quantity: 4, filledQuantity: 2 }),
      )
      throw new Error('response lost after acceptance')
    },
  } as unknown as APIRequestContext
  const api = guardBrokerRequests(client, true, h.tracker.recordResponse, h.tracker.prepareRequest)
  try {
    await assert.rejects(
      api.post('/api/v1/ibkr/orders', {
        data: { draft: order('intent', 'buy', 0), expectedExecutionEnvironment: 'paper' },
      }),
      /response lost/,
    )
    await h.tracker.cleanup(h.probe, session)
    assert.deepEqual(
      h.closes.map((d) => [d.side, d.quantity]),
      [['sell', 2]],
    )
    assert.deepEqual(h.cancelled, [])
  } finally {
    h.tracker.dispose()
  }
})

test('every attempted order has a unique marker and marker reuse is rejected before dispatch', () => {
  const h = harness([])
  try {
    const first = h.tracker.prepareRequest('/api/v1/ibkr/orders', 'POST', {
      draft: order('intent', 'buy', 0),
      expectedExecutionEnvironment: 'paper',
    })
    const second = h.tracker.prepareRequest('/api/v1/ibkr/orders', 'POST', {
      draft: order('intent', 'buy', 0),
      expectedExecutionEnvironment: 'paper',
    })
    assert.notEqual(first.attemptId, second.attemptId)
    assert.throws(
      () => h.tracker.prepareRequest('/api/v1/ibkr/orders', 'POST', first.body),
      /cannot be reused/,
    )
  } finally {
    h.tracker.dispose()
  }
})

for (const ambiguous of [false, true])
  test(`lost receipt with ${ambiguous ? 'ambiguous' : 'no'} exact marker fails closed`, async () => {
    const h = harness([order('unrelated', 'buy', 10, { quantity: 10 })])
    const entry = order('owned', 'buy', 2)
    tagged(h, entry)
    if (ambiguous) h.state.ordersHistory!.push(entry, { ...entry, id: 'second-root' })
    try {
      await assert.rejects(
        h.tracker.cleanup(h.probe, session),
        ambiguous ? /Ambiguous/ : /no exact .*ownership match/,
      )
      assert.deepEqual(h.closes, [])
      assert.deepEqual(h.cancelled, [])
    } finally {
      h.tracker.dispose()
    }
  })

test('an explicit rejected request with no retained order is not unknown ownership', async () => {
  const h = harness([order('unrelated', 'buy', 10, { quantity: 10 })])
  const prepared = tagged(h, order('attempt', 'buy', 0))
  try {
    await h.tracker.recordResponse(
      response({ error: 'preview rejected' }, 400, '/api/v1/ibkr/orders'),
      'POST',
      prepared.attemptId,
    )
    await h.tracker.cleanup(h.probe, session)
    assert.deepEqual(h.closes, [])
  } finally {
    h.tracker.dispose()
  }
})

test('lost position-close without an exact retained match still blocks fill recovery', async () => {
  const entry = order('entry', 'buy', 2),
    h = harness([entry])
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    h.tracker.prepareRequest('/api/v1/ibkr/positions/exact-position/close', 'POST', {
      expectedExecutionEnvironment: 'paper',
      options: { quantity: 2 },
    })
    await assert.rejects(h.tracker.cleanup(h.probe, session), /outcome unknown/)
    assert.deepEqual(h.closes, [])
  } finally {
    h.tracker.dispose()
  }
})

test('successful native close receipts net with entries even if the caller stopped after receiving one', async () => {
  const entry = order('entry', 'buy', 4),
    close = order('native-close', 'sell', 3),
    h = harness([entry, close])
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    const prepared = h.tracker.prepareRequest(
      '/api/v1/ibkr/positions/exact-position/close',
      'POST',
      { expectedExecutionEnvironment: 'paper', context: { accountId: 'paper-test' } },
    )
    close.customFields = {
      [PAPER_OWNER_FIELD]: (prepared.body as { options: { paperOwnershipId: string } }).options
        .paperOwnershipId,
    }
    await h.tracker.recordResponse(
      response({ order: close }, 201, '/api/v1/ibkr/positions/exact-position/close'),
      'POST',
      prepared.attemptId,
    )
    await h.tracker.cleanup(h.probe, session)
    assert.deepEqual(
      h.closes.map((d) => [d.side, d.quantity]),
      [['sell', 1]],
    )
  } finally {
    h.tracker.dispose()
  }
})

test('known owned working family is cancelled before its partial fills are netted', async () => {
  const entry = order('entry', 'buy', 3, { status: 'working', remainingQuantity: 1 })
  const child = order('child', 'sell', 1, {
    parentId: 'entry',
    status: 'working',
    remainingQuantity: 3,
  })
  const h = harness([
    entry,
    child,
    order('user-working', 'buy', 0, { status: 'working', remainingQuantity: 4 }),
  ])
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    await h.tracker.cleanup(h.probe, session)
    assert.deepEqual(h.cancelled, ['entry', 'child'])
    assert.deepEqual(
      h.closes.map((d) => [d.side, d.quantity]),
      [['sell', 2]],
    )
    assert.deepEqual(
      h.state.orders.map((o) => o.id),
      ['user-working'],
    )
    await h.tracker.cleanup(h.probe, session)
    assert.equal(h.closes.length, 1)
  } finally {
    h.tracker.dispose()
  }
})

test('partial fallback-close fills are included before the remaining owned quantity is retried', async () => {
  const entry = order('entry', 'buy', 4),
    h = harness([entry])
  const post = h.probe.post.bind(h.probe)
  h.probe.post = async (...args: Parameters<APIRequestContext['post']>) => {
    const result = await post(...args)
    if (h.closes.length === 1 && args[0].endsWith('/orders')) {
      const close = h.state.ordersHistory!.at(-1)!
      close.filledQuantity = 1
      close.status = 'cancelled'
    }
    return result
  }
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    await h.tracker.cleanup(h.probe, session)
    assert.deepEqual(
      h.closes.map((d) => d.quantity),
      [4, 3],
    )
    await h.tracker.cleanup(h.probe, session)
    assert.equal(h.closes.length, 2)
  } finally {
    h.tracker.dispose()
  }
})

for (const fault of [
  'missing-history',
  'generation',
  'account',
  'unconfirmed-absence',
  'duplicate-quantity',
] as const)
  test(`cleanup refuses ${fault} before any fallback mutation`, async () => {
    const entry = order('entry', 'buy', 2),
      h = harness([entry])
    const prepared = tagged(
      h,
      entry,
      fault === 'generation' ? { 'x-tradescript-connection': 'original' } : {},
    )
    try {
      await h.tracker.recordResponse(
        response({ order: entry }, 201, '/api/v1/ibkr/orders'),
        'POST',
        prepared.attemptId,
      )
      if (fault === 'missing-history') h.state.ordersHistory = []
      if (fault === 'account') entry.accountId = 'other-paper'
      if (fault === 'unconfirmed-absence') entry.customFields!.ibkrMissingOpenOrder = true
      if (fault === 'duplicate-quantity') h.state.orders.push({ ...entry, quantity: 9 })
      await assert.rejects(h.tracker.cleanup(h.probe, session))
      assert.deepEqual(h.closes, [])
      assert.deepEqual(h.cancelled, [])
    } finally {
      h.tracker.dispose()
    }
  })

test('conflicting unrelated history is ignored rather than adopted or used for sizing', async () => {
  const entry = order('entry', 'buy', 1),
    unrelated = order('user', 'buy', 100, { quantity: 100 })
  const h = harness([entry, unrelated])
  h.state.orders.push({ ...unrelated, filledQuantity: 999 })
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    await h.tracker.cleanup(h.probe, session)
    assert.deepEqual(
      h.closes.map((d) => d.quantity),
      [1],
    )
    assert.deepEqual(h.cancelled, [])
  } finally {
    h.tracker.dispose()
  }
})

const optionContract = {
  underlying: 'AAPL',
  underlyingSymbolInfo: symbol,
  expiration: '2026-10-16',
  strike: 200,
  right: 'call' as const,
  multiplier: 100,
  currency: 'USD',
  brokerContractId: 202,
}
const optionSymbol = {
  ...symbol,
  symbol: 'AAPL',
  canonicalSymbol: 'IBKR:202',
  assetClass: 'option',
  contractIdentity: {
    securityType: 'OPT',
    conId: 202,
    expiry: '20261016',
    strike: 200,
    right: 'C',
    multiplier: 100,
  },
}
for (const underlying of [false, true])
  test(`one-leg option cleanup ${underlying ? 'refuses an underlying STK parent' : 'preserves exact option identity and close effect'}`, async () => {
    const entry = order('option-entry', 'buy', 2, {
      symbol: underlying ? symbol : optionSymbol,
      optionLegs: [
        { contract: optionContract, side: 'buy', quantity: 4, ratio: 1, positionEffect: 'open' },
      ],
    })
    const h = harness([entry])
    try {
      await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
      if (underlying) {
        await assert.rejects(h.tracker.cleanup(h.probe, session), /option leg does not match/)
        assert.deepEqual(h.closes, [])
      } else {
        await h.tracker.cleanup(h.probe, session)
        assert.equal(h.closes[0]?.symbol.contractIdentity?.conId, 202)
        assert.deepEqual(
          h.closes[0]?.optionLegs?.map((l) => [
            l.contract.brokerContractId,
            l.side,
            l.quantity,
            l.positionEffect,
          ]),
          [[202, 'sell', 2, 'close']],
        )
      }
    } finally {
      h.tracker.dispose()
    }
  })

test('filled multi-leg strategy without authoritative per-leg fill facts refuses scalar fallback', async () => {
  const entry = order('spread', 'buy', 1, {
    optionLegs: [
      { contract: optionContract, side: 'buy', quantity: 4, positionEffect: 'open' },
      {
        contract: { ...optionContract, brokerContractId: 203, strike: 210 },
        side: 'sell',
        quantity: 4,
        positionEffect: 'open',
      },
    ],
  })
  const h = harness([entry])
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    await assert.rejects(h.tracker.cleanup(h.probe, session), /authoritative per-leg fills/)
    assert.deepEqual(h.closes, [])
  } finally {
    h.tracker.dispose()
  }
})

test('a failed fallback polling read cancels the known working close and leaves unrelated orders untouched', async () => {
  const entry = order('entry', 'buy', 2),
    user = order('user', 'buy', 0, { status: 'working' }),
    h = harness([entry, user])
  const post = h.probe.post.bind(h.probe),
    get = h.probe.get.bind(h.probe)
  let failNextRead = false
  h.probe.post = async (...args: Parameters<APIRequestContext['post']>) => {
    const result = await post(...args)
    if (args[0].endsWith('/orders')) {
      const close = h.state.ordersHistory!.pop()!
      close.status = 'working'
      close.filledQuantity = 0
      close.remainingQuantity = close.quantity
      h.state.orders.push(close)
      failNextRead = true
    }
    return result
  }
  h.probe.get = async (...args: Parameters<APIRequestContext['get']>) => {
    if (failNextRead) {
      failNextRead = false
      return response({ error: 'temporary read failure' }, 503)
    }
    return get(...args)
  }
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    await assert.rejects(h.tracker.cleanup(h.probe, session))
    assert.deepEqual(h.cancelled, ['cleanup-1'])
    assert.deepEqual(
      h.state.orders.map((o) => o.id),
      ['user'],
    )
  } finally {
    h.tracker.dispose()
  }
})

for (const fault of ['wrong-native-class', 'contradictory-identity', 'child-contract'] as const)
  test(`retained ${fault} fails before fallback placement`, async () => {
    const entry = order('entry', 'buy', 2, { symbol: optionSymbol })
    const h = harness([entry])
    try {
      await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
      if (fault === 'wrong-native-class') entry.symbol = { ...optionSymbol, assetClass: 'stock' }
      if (fault === 'contradictory-identity') {
        const close = order('caller-close', 'sell', 1, {
          symbol: {
            ...optionSymbol,
            contractIdentity: { ...optionSymbol.contractIdentity, right: 'P' },
          },
        })
        h.state.ordersHistory!.push(close)
        await h.tracker.recordResponse(
          response({ order: close }, 201, '/api/v1/ibkr/orders'),
          'POST',
        )
      }
      if (fault === 'child-contract')
        h.state.ordersHistory!.push(order('child', 'sell', 1, { parentId: 'entry', symbol }))
      await assert.rejects(h.tracker.cleanup(h.probe, session))
      assert.deepEqual(h.closes, [])
    } finally {
      h.tracker.dispose()
    }
  })

const cryptoSymbol = {
  ...symbol,
  symbol: 'BTC',
  assetClass: 'crypto',
  exchange: 'PAXOS',
  canonicalSymbol: 'IBKR:301',
  contractIdentity: { securityType: 'CRYPTO', conId: 301 },
}
for (const mode of ['exact-step', 'below-step', 'over-round', 'wrong-session'] as const)
  test(`crypto fallback ${mode} uses only authoritative increments and never over-closes`, async () => {
    const amount = mode === 'below-step' ? 0.00001 : mode === 'over-round' ? 0.00016 : 0.0002
    const entry = order('crypto-entry', 'buy', amount, { symbol: cryptoSymbol, quantity: 0.001 })
    const h = harness([entry]),
      get = h.probe.get.bind(h.probe)
    h.probe.get = async (...args: Parameters<APIRequestContext['get']>) =>
      args[0].includes('/sessions?')
        ? response({
            symbol: {
              canonicalSymbol: mode === 'wrong-session' ? 'IBKR:999' : 'IBKR:301',
              type: 'crypto',
              currency: 'USD',
            },
            metadata: { quantityStep: 0.0001 },
          })
        : get(...args)
    try {
      await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
      if (mode === 'exact-step') {
        await h.tracker.cleanup(h.probe, session)
        assert.deepEqual(
          h.closes.map((d) => [d.side, d.quantity, d.duration, d.symbol.contractIdentity?.conId]),
          [['sell', amount, 'ioc', 301]],
        )
      } else {
        await assert.rejects(h.tracker.cleanup(h.probe, session))
        assert.deepEqual(h.closes, [])
      }
    } finally {
      h.tracker.dispose()
    }
  })

const forecastSymbol = (id: number, right: string, strike = 2): Order['symbol'] => ({
  symbol: 'EVENT',
  canonicalSymbol: `IBKR:${id}`,
  exchange: 'FORECASTX',
  currency: 'USD',
  assetClass: 'event-contract',
  contractIdentity: {
    securityType: 'OPT',
    conId: id,
    right,
    strike,
    expiry: '20261016',
    tradingClass: 'EVENT',
    multiplier: 1,
  },
})
for (const mode of ['remaining', 'already-offset', 'wrong-event', 'wrong-quote'] as const)
  test(`ForecastEx fallback ${mode} requires the exact opposing event and fresh quote`, async () => {
    const entry = order('event-entry', 'buy', 4, { symbol: forecastSymbol(401, 'C') })
    const close = order('caller-event-close', 'buy', mode === 'already-offset' ? 4 : 1, {
      symbol: forecastSymbol(402, 'P'),
    })
    const h = harness([entry, close]),
      get = h.probe.get.bind(h.probe)
    h.probe.get = async (...args: Parameters<APIRequestContext['get']>) => {
      if (args[0].includes('/opposing-outcome?'))
        return response(forecastSymbol(402, 'P', mode === 'wrong-event' ? 3 : 2))
      if (args[0].includes('/quotes?'))
        return response([
          {
            symbol: {
              ...forecastSymbol(402, 'P'),
              currency: mode === 'wrong-quote' ? 'EUR' : 'USD',
            },
            status: 'ok',
            ask: 0.25,
            timestamp: new Date().toISOString(),
          },
        ])
      return get(...args)
    }
    try {
      for (const receipt of [entry, close])
        await h.tracker.recordResponse(
          response({ order: receipt }, 201, '/api/v1/ibkr/orders'),
          'POST',
        )
      if (mode === 'wrong-event' || mode === 'wrong-quote') {
        await assert.rejects(h.tracker.cleanup(h.probe, session))
        assert.deepEqual(h.closes, [])
      } else {
        await h.tracker.cleanup(h.probe, session)
        assert.deepEqual(
          h.closes.map((d) => [
            d.side,
            d.quantity,
            d.type,
            d.limitPrice,
            d.symbol.contractIdentity?.conId,
          ]),
          mode === 'already-offset' ? [] : [['buy', 3, 'limit', 0.25, 402]],
        )
      }
    } finally {
      h.tracker.dispose()
    }
  })

test('browser dispatch guard adds the unique marker before forwarding and recovers a lost browser receipt', async () => {
  const h = harness([])
  let handler: ((route: import('@playwright/test').Route) => Promise<void>) | undefined
  const context = h.context as unknown as BrowserContext
  context.route = async (_url, value) => {
    handler = value as typeof handler
    return { dispose: async () => {}, [Symbol.dispose]() {}, async [Symbol.asyncDispose]() {} }
  }
  const request = {
    url: () => 'http://localhost/api/v1/ibkr/orders',
    method: () => 'POST',
    headers: () => ({}),
    postDataJSON: () => ({
      draft: order('intent', 'buy', 0),
      expectedExecutionEnvironment: 'paper',
    }),
  } as unknown as import('@playwright/test').Request
  try {
    await guardBrowserMutations(context, true, h.tracker.prepareBrowserRequest)
    assert.ok(handler)
    await handler({
      request: () => request,
      fallback: async (options: { postData: string }) => {
        const body = JSON.parse(options.postData) as { draft: OrderDraft }
        assert.equal(typeof body.draft.customFields?.[PAPER_OWNER_FIELD], 'string')
        h.state.ordersHistory!.push(
          order('browser-accepted', 'buy', 1, { ...body.draft, filledQuantity: 1 }),
        )
      },
    } as unknown as import('@playwright/test').Route)
    await h.tracker.cleanup(h.probe, session)
    assert.deepEqual(
      h.closes.map((d) => d.quantity),
      [1],
    )
  } finally {
    h.tracker.dispose()
  }
})

test('an option pre-submit underlying descriptor is preserved while authoritative option readback supplies the cleanup target', async () => {
  const original = order('intent', 'buy', 0, {
    optionLegs: [{ contract: optionContract, side: 'buy', quantity: 4, positionEffect: 'open' }],
  })
  const h = harness([]),
    prepared = tagged(h, original)
  const readback = { ...original, symbol: optionSymbol, filledQuantity: 2 }
  h.state.ordersHistory!.push(readback)
  try {
    await h.tracker.recordResponse(
      response({ order: readback }, 201, '/api/v1/ibkr/orders'),
      'POST',
      prepared.attemptId,
    )
    await h.tracker.cleanup(h.probe, session)
    assert.equal(h.closes[0]?.symbol.contractIdentity?.conId, 202)
    assert.equal(h.closes[0]?.optionLegs?.[0]?.contract.brokerContractId, 202)
  } finally {
    h.tracker.dispose()
  }
})

test('single option close direction is independent of entry/caller-close history ordering', async () => {
  const entry = order('option-entry', 'buy', 4, {
    symbol: optionSymbol,
    optionLegs: [{ contract: optionContract, side: 'buy', quantity: 4, positionEffect: 'open' }],
  })
  const close = order('prior-close', 'sell', 1, {
    symbol: optionSymbol,
    quantity: 1,
    optionLegs: [{ contract: optionContract, side: 'sell', quantity: 1, positionEffect: 'close' }],
  })
  const h = harness([close, entry])
  try {
    for (const receipt of [entry, close])
      await h.tracker.recordResponse(
        response({ order: receipt }, 201, '/api/v1/ibkr/orders'),
        'POST',
      )
    await h.tracker.cleanup(h.probe, session)
    assert.equal(h.closes[0]?.side, 'sell')
    assert.deepEqual(
      h.closes[0]?.optionLegs?.map((leg) => [leg.side, leg.quantity, leg.positionEffect]),
      [['sell', 3, 'close']],
    )
  } finally {
    h.tracker.dispose()
  }
})

for (const field of ['parentId', 'bracketGroupId', 'clientId', 'brokerOrderId', 'permId'] as const)
  test(`duplicate owned readback with conflicting ${field} fails closed`, async () => {
    const entry = order('entry', 'buy', 2),
      h = harness([entry])
    h.state.orders.push({
      ...entry,
      [field]: ['parentId', 'bracketGroupId'].includes(field) ? 'other-order' : 7,
    })
    try {
      await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
      await assert.rejects(h.tracker.cleanup(h.probe, session), /Conflicting/)
      assert.deepEqual(h.closes, [])
      assert.deepEqual(h.cancelled, [])
    } finally {
      h.tracker.dispose()
    }
  })

test('lost fallback POST plus transient recovery lookup failure still discovers and cancels its exact tagged close', async () => {
  const entry = order('entry', 'buy', 2),
    user = order('user', 'buy', 0, { status: 'working' }),
    h = harness([entry, user])
  const post = h.probe.post.bind(h.probe),
    get = h.probe.get.bind(h.probe)
  let failNextRead = false
  h.probe.post = async (...args: Parameters<APIRequestContext['post']>) => {
    const result = await post(...args)
    if (args[0].endsWith('/orders')) {
      const close = h.state.ordersHistory!.pop()!
      close.status = 'working'
      close.filledQuantity = 0
      close.remainingQuantity = close.quantity
      h.state.orders.push(close)
      failNextRead = true
      throw new Error('accepted close response lost')
    }
    return result
  }
  h.probe.get = async (...args: Parameters<APIRequestContext['get']>) => {
    if (failNextRead) {
      failNextRead = false
      return response({ error: 'read outage' }, 503)
    }
    return get(...args)
  }
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    await assert.rejects(h.tracker.cleanup(h.probe, session))
    assert.deepEqual(h.cancelled, ['cleanup-1'])
    assert.deepEqual(
      h.state.orders.map((o) => o.id),
      ['user'],
    )
    assert.equal(h.closes.length, 1)
  } finally {
    h.tracker.dispose()
  }
})

for (const [securityType, assetClass] of [
  ['WAR', 'warrant'],
  ['CMDTY', 'commodity'],
  ['CFD', 'cfd'],
  ['FUND', 'fund'],
  ['IND', 'index'],
] as const)
  for (const offset of [false, true])
    test(`${securityType} native family ${offset ? 'already-offset' : 'residual'} cleanup policy stays exact`, async () => {
      const native = {
        ...symbol,
        symbol: 'NATIVE',
        canonicalSymbol: 'IBKR:601',
        assetClass,
        contractIdentity: { securityType, conId: 601 },
      }
      const entry = order('entry', 'buy', 2, { symbol: native })
      const close = order('caller-close', 'sell', offset ? 2 : 1, { symbol: native })
      const h = harness([entry, close])
      try {
        for (const receipt of [entry, close])
          await h.tracker.recordResponse(
            response({ order: receipt }, 201, '/api/v1/ibkr/orders'),
            'POST',
          )
        if (!offset && ['FUND', 'IND'].includes(securityType)) {
          await assert.rejects(h.tracker.cleanup(h.probe, session), /no explicit close policy/)
          assert.deepEqual(h.closes, [])
        } else {
          await h.tracker.cleanup(h.probe, session)
          assert.deepEqual(
            h.closes.map((d) => [d.side, d.quantity, d.duration, d.symbol.contractIdentity?.conId]),
            offset ? [] : [['sell', 1, 'day', 601]],
          )
        }
      } finally {
        h.tracker.dispose()
      }
    })

test('filled status with an incomplete cumulative total cannot claim full exposure cleanup', async () => {
  const entry = order('entry', 'buy', 1, { status: 'filled' }),
    h = harness([entry])
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    await assert.rejects(h.tracker.cleanup(h.probe, session), /Filled status contradicts/)
    assert.deepEqual(h.closes, [])
  } finally {
    h.tracker.dispose()
  }
})

test('duplicate safety metadata cannot erase unsupported native readback facts', async () => {
  const entry = order('entry', 'buy', 1, { customFields: { ibkrReadbackUnsupported: true } }),
    h = harness([entry])
  h.state.orders.push({ ...entry, customFields: {} })
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    await assert.rejects(h.tracker.cleanup(h.probe, session), /Conflicting/)
    assert.deepEqual(h.closes, [])
  } finally {
    h.tracker.dispose()
  }
})

for (const status of ['rejected', 'inactive', 'cancelled'] as const)
  test(`a ${status} fallback close with no fills is not blindly retried`, async () => {
    const entry = order('entry', 'buy', 2),
      h = harness([entry]),
      post = h.probe.post.bind(h.probe)
    h.probe.post = async (...args: Parameters<APIRequestContext['post']>) => {
      const result = await post(...args)
      if (args[0].endsWith('/orders')) {
        const close = h.state.ordersHistory!.at(-1)!
        close.status = status
        close.filledQuantity = 0
      }
      return result
    }
    try {
      await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
      await assert.rejects(h.tracker.cleanup(h.probe, session), /no retry was sent/)
      assert.equal(h.closes.length, 1)
    } finally {
      h.tracker.dispose()
    }
  })

test('a derived owned-child ID retains conflicting foreign-parent duplicates for validation', async () => {
  const entry = order('entry', 'buy', 2),
    child = order('child', 'sell', 1, { parentId: 'entry', status: 'working' })
  const h = harness([entry, child])
  h.state.ordersHistory!.push({ ...child, parentId: 'foreign-parent' })
  try {
    await h.tracker.recordResponse(response({ order: entry }, 201, '/api/v1/ibkr/orders'), 'POST')
    await assert.rejects(h.tracker.cleanup(h.probe, session), /Conflicting/)
    assert.deepEqual(h.closes, [])
    assert.deepEqual(h.cancelled, [])
  } finally {
    h.tracker.dispose()
  }
})

for (const mismatched of [false, true])
  test(`fully filled caller combo cleanup ${mismatched ? 'with different exact legs' : 'with identical leg units'} stays unresolved without authoritative per-leg facts`, async () => {
    const entry = order('spread-entry', 'buy', 4, {
      optionLegs: [
        { contract: optionContract, side: 'buy', quantity: 4, positionEffect: 'open' },
        {
          contract: { ...optionContract, strike: 210, brokerContractId: 203 },
          side: 'sell',
          quantity: 8,
          positionEffect: 'open',
        },
      ],
    })
    const close = order('spread-close', 'sell', 4, {
      optionLegs: [
        { contract: optionContract, side: 'sell', quantity: 4, positionEffect: 'close' },
        {
          contract: { ...optionContract, strike: 210, brokerContractId: mismatched ? 204 : 203 },
          side: 'buy',
          quantity: 8,
          positionEffect: 'close',
        },
      ],
    })
    const h = harness([close, entry])
    try {
      for (const receipt of [entry, close])
        await h.tracker.recordResponse(
          response({ order: receipt }, 201, '/api/v1/ibkr/orders'),
          'POST',
        )
      await assert.rejects(h.tracker.cleanup(h.probe, session), /authoritative per-leg fills/)
      assert.deepEqual(h.closes, [])
      assert.deepEqual(h.cancelled, [])
    } finally {
      h.tracker.dispose()
    }
  })
