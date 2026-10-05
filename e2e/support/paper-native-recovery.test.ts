import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type {
  BrokerState,
  BrokerSymbol,
  Execution,
  Order,
  OrderDraft,
  PaperOwnershipRecovery,
} from '@ibkr-terminal/contracts'
import type { APIRequestContext, APIResponse, BrowserContext } from '@playwright/test'
import { ownedRecoveryDrafts, PAPER_OWNER_FIELD } from './paper-fill-recovery.js'
import { trackPaperOrders } from './paper-order-tracker.js'

const underlying: BrokerSymbol = {
  symbol: 'TEST',
  canonicalSymbol: 'IBKR:101',
  assetClass: 'stock',
  exchange: 'SMART',
  currency: 'USD',
  contractIdentity: { conId: 101, securityType: 'STK' },
}
const optionSymbol = (conId: number): BrokerSymbol => ({
  symbol: 'TEST',
  canonicalSymbol: `IBKR:${conId}`,
  assetClass: 'option',
  exchange: 'SMART',
  currency: 'USD',
  contractIdentity: {
    conId,
    securityType: 'OPT',
    expiry: '20261218',
    strike: conId,
    right: 'C',
    multiplier: 100,
  },
})
const ordinary = (
  id: string,
  side: 'buy' | 'sell',
  quantity: number,
  extra: Partial<Order> = {},
): Order => ({
  id,
  accountId: 'DU-test',
  symbol: underlying,
  side,
  quantity,
  filledQuantity: quantity,
  type: 'market',
  duration: 'day',
  status: 'filled',
  submittedAt: '2026-09-30T10:00:00Z',
  updatedAt: '2026-09-30T10:00:01Z',
  ...extra,
})
function spread(extra: Partial<Order> = {}): Order {
  const ownerId = randomUUID()
  return ordinary('combo', 'buy', 4, {
    brokerOrderId: 100,
    clientId: 17,
    permId: 700,
    brokerOrderRef: `tspe:${ownerId}:100`,
    customFields: { [PAPER_OWNER_FIELD]: ownerId },
    optionLegs: [201, 202].map((conId, index) => ({
      contract: {
        underlying: 'TEST',
        underlyingSymbolInfo: underlying,
        brokerContractId: conId,
        currency: 'USD',
        expiration: '20261218',
        strike: conId,
        right: 'call',
        multiplier: 100,
      },
      side: index === 0 ? 'buy' : 'sell',
      ratio: index === 0 ? 1 : 2,
      quantity: index === 0 ? 4 : 8,
      positionEffect: 'open',
    })),
    ...extra,
  })
}
function nativeFill(
  parent: Order,
  conId: number,
  quantity: number,
  extra: Partial<Execution> = {},
): Execution {
  return {
    id: `leg-${conId}.01`,
    accountId: parent.accountId,
    orderId: parent.id,
    brokerOrderId: parent.brokerOrderId,
    clientId: parent.clientId,
    permId: parent.permId,
    brokerOrderRef: parent.brokerOrderRef,
    symbol: optionSymbol(conId),
    side: conId === 201 ? 'buy' : 'sell',
    quantity,
    cumulativeQuantity: quantity,
    price: 1,
    timestamp: '',
    ...extra,
  }
}
const unusedRequest = {} as APIRequestContext
test('exact actual leg fills emit two native close orders without using parent units', async () => {
  const parent = spread()
  const drafts = await ownedRecoveryDrafts(
    unusedRequest,
    [parent],
    [nativeFill(parent, 201, 4), nativeFill(parent, 202, 8)],
    new Set([parent.id]),
  )
  assert.deepEqual(
    drafts.map((draft) => [draft.symbol.contractIdentity?.conId, draft.side, draft.quantity]),
    [
      [201, 'sell', 4],
      [202, 'buy', 8],
    ],
  )
  assert.equal(
    drafts.every((draft) => draft.optionLegs?.[0]?.positionEffect === 'close'),
    true,
  )
})
test('nonuniform actual partial leg fills close their exact sizes, not cancelled parent cumulative units', async () => {
  const parent = spread({ status: 'cancelled', filledQuantity: 1 })
  const drafts = await ownedRecoveryDrafts(
    unusedRequest,
    [parent],
    [nativeFill(parent, 201, 2), nativeFill(parent, 202, 3)],
    new Set([parent.id]),
  )
  assert.deepEqual(
    drafts.map((draft) => [draft.side, draft.quantity]),
    [
      ['sell', 2],
      ['buy', 3],
    ],
  )
})
test('complete exact leg replay sizes recovery even when parent cumulative units are unknown', async () => {
  const parent = spread({ filledQuantity: undefined })
  const drafts = await ownedRecoveryDrafts(
    unusedRequest,
    [parent],
    [nativeFill(parent, 201, 4), nativeFill(parent, 202, 8)],
    new Set([parent.id]),
  )
  assert.deepEqual(
    drafts.map((draft) => draft.quantity),
    [4, 8],
  )
  const cancelled = spread({ status: 'cancelled', filledQuantity: undefined })
  assert.deepEqual(
    (
      await ownedRecoveryDrafts(
        unusedRequest,
        [cancelled],
        [nativeFill(cancelled, 201, 1)],
        new Set([cancelled.id]),
        new Set([cancelled.id]),
      )
    ).map((draft) => draft.quantity),
    [1],
  )
  assert.deepEqual(
    await ownedRecoveryDrafts(
      unusedRequest,
      [cancelled],
      [],
      new Set([cancelled.id]),
      new Set([cancelled.id]),
    ),
    [],
  )
})
test('a one-sided native strategy fill is recovered even when parent cumulative units are zero', async () => {
  const parent = spread({ status: 'cancelled', filledQuantity: 0 })
  const drafts = await ownedRecoveryDrafts(
    unusedRequest,
    [parent],
    [nativeFill(parent, 201, 1)],
    new Set([parent.id]),
    new Set([parent.id]),
  )
  assert.deepEqual(
    drafts.map((draft) => [draft.symbol.contractIdentity?.conId, draft.side, draft.quantity]),
    [[201, 'sell', 1]],
  )
})
test('zero native leg totals require complete uninterrupted dispatch coverage and fresh replay', async () => {
  const parent = spread({ status: 'cancelled', filledQuantity: 0 })
  assert.deepEqual(
    await ownedRecoveryDrafts(
      unusedRequest,
      [parent],
      [],
      new Set([parent.id]),
      new Set([parent.id]),
    ),
    [],
  )
  await assert.rejects(
    ownedRecoveryDrafts(unusedRequest, [parent], [], new Set([parent.id])),
    /no authoritative execution total/,
  )
  await assert.rejects(
    ownedRecoveryDrafts(unusedRequest, [parent], [], new Set(), new Set([parent.id])),
    /authoritative per-leg fills/,
  )
})
test('positive strategy-unit evidence cannot be treated as absent native legs with zero exposure', async () => {
  const parent = spread({ status: 'cancelled', filledQuantity: 1 })
  await assert.rejects(
    ownedRecoveryDrafts(unusedRequest, [parent], [], new Set([parent.id]), new Set([parent.id])),
    /execution total/,
  )
  const zeroParent = spread({ status: 'cancelled', filledQuantity: 0 })
  const bagFill = nativeFill(zeroParent, 201, 1, {
    symbol: { ...underlying, contractIdentity: { securityType: 'BAG' } },
  })
  await assert.rejects(
    ownedRecoveryDrafts(
      unusedRequest,
      [zeroParent],
      [bagFill],
      new Set([zeroParent.id]),
      new Set([zeroParent.id]),
    ),
    /execution total/,
  )
})
test('an old/restarted absent native leg remains unknown outside retained replay coverage', async () => {
  const parent = spread({
    status: 'cancelled',
    filledQuantity: 0,
    submittedAt: '2026-09-28T10:00:00Z',
  })
  await assert.rejects(
    ownedRecoveryDrafts(
      unusedRequest,
      [parent],
      [nativeFill(parent, 201, 1)],
      new Set([parent.id]),
    ),
    /no authoritative execution total/,
  )
})
test('prior exact leg cleanup receipts net against actual executions and never create underlying stock closes', async () => {
  const parent = spread(),
    closes = [
      ordinary('close-a', 'sell', 4, { symbol: optionSymbol(201) }),
      ordinary('close-b', 'buy', 8, { symbol: optionSymbol(202) }),
    ]
  assert.deepEqual(
    await ownedRecoveryDrafts(
      unusedRequest,
      [closes[1]!, parent, closes[0]!],
      [nativeFill(parent, 201, 4), nativeFill(parent, 202, 8)],
      new Set([parent.id]),
    ),
    [],
  )
})
test('exact corrected leg executions replace prior quantities before residual sizing', async () => {
  const parent = spread({ status: 'cancelled', filledQuantity: 1 })
  const fills = [
    nativeFill(parent, 201, 4),
    nativeFill(parent, 201, 2, { id: 'leg-201.02' }),
    nativeFill(parent, 202, 3),
  ]
  assert.deepEqual(
    (await ownedRecoveryDrafts(unusedRequest, [parent], fills, new Set([parent.id]))).map(
      (draft) => draft.quantity,
    ),
    [2, 3],
  )
})
for (const fault of [
  'missing-cumulative',
  'incomplete-cumulative',
  'wrong-account',
  'wrong-perm',
  'wrong-ref',
  'wrong-side',
  'wrong-currency',
  'wrong-contract',
  'wrong-option-multiplier',
  'no-replay',
] as const)
  test(`per-leg recovery refuses ${fault} before constructing a close`, async () => {
    const parent = spread(),
      fill = nativeFill(parent, 201, 4),
      second = nativeFill(parent, 202, 8)
    if (fault === 'missing-cumulative') fill.cumulativeQuantity = undefined
    if (fault === 'incomplete-cumulative') fill.cumulativeQuantity = 5
    if (fault === 'wrong-account') fill.accountId = 'DU-other'
    if (fault === 'wrong-perm') fill.permId = 999
    if (fault === 'wrong-ref') fill.brokerOrderRef = `tspe:${randomUUID()}:100`
    if (fault === 'wrong-side') fill.side = 'sell'
    if (fault === 'wrong-currency') fill.symbol = { ...fill.symbol, currency: 'EUR' }
    if (fault === 'wrong-contract') fill.symbol = optionSymbol(999)
    if (fault === 'wrong-option-multiplier')
      fill.symbol = {
        ...fill.symbol,
        contractIdentity: { ...fill.symbol.contractIdentity!, multiplier: 50 },
      }
    await assert.rejects(
      ownedRecoveryDrafts(
        unusedRequest,
        [parent],
        [fill, second],
        fault === 'no-replay' ? new Set() : new Set([parent.id]),
      ),
    )
  })

const response = (body: unknown, status = 200, path = '/api/v1/ibkr/state'): APIResponse =>
  ({
    status: () => status,
    url: () => `http://localhost${path}`,
    headers: () => ({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
    json: async () => body,
  }) as unknown as APIResponse
function transportHarness() {
  const tracker = trackPaperOrders(new EventEmitter() as unknown as BrowserContext, true)
  const state = {
    orders: [],
    ordersHistory: [],
    executions: [],
    activeAccountId: 'DU-test',
  } as unknown as BrokerState
  const snapshots = new Map<string, PaperOwnershipRecovery>(),
    closes: OrderDraft[] = [],
    calls: string[] = [],
    cancelled: string[] = []
  const probe = {
    get: async (path: string) => {
      calls.push(path)
      if (path.includes('/paper-ownership/'))
        return response(snapshots.get(path.split('/').at(-1)!) ?? { outcome: 'unknown' })
      return response(state)
    },
    post: async (path: string, options: { data: { draft: OrderDraft } }) => {
      calls.push(path)
      if (path.endsWith('/reconcile')) {
        const snapshot = snapshots.get(path.split('/').at(-2)!)
        return response(
          snapshot ? { ...snapshot, executionsReconciled: true } : { outcome: 'unknown' },
        )
      }
      if (path.endsWith('/preview')) return response({ accepted: true })
      closes.push(options.data.draft)
      const filled = ordinary(
        `fallback-${closes.length}`,
        options.data.draft.side,
        options.data.draft.quantity,
        { ...options.data.draft },
      )
      state.ordersHistory!.push(filled)
      return response({ order: filled }, 201, path)
    },
    delete: async (path: string) => {
      const id = path.split('/').at(-1)!
      cancelled.push(id)
      for (const snapshot of snapshots.values())
        for (const order of snapshot.orders) if (order.id === id) order.status = 'cancelled'
      return response({ ok: true }, 200, path)
    },
  } as unknown as APIRequestContext
  const session = {
    csrfToken: 'synthetic',
    expiresAt: '',
    mutationHeaders: { 'x-tradescript-connection': 'new-generation' },
  }
  const prepare = (record: Order, originalGeneration = 'new-generation', positionClose = false) => {
    const path = positionClose
      ? '/api/v1/ibkr/positions/exact-native-position/close'
      : '/api/v1/ibkr/orders'
    const result = tracker.prepareRequest(
      path,
      'POST',
      {
        expectedExecutionEnvironment: 'paper',
        context: { accountId: 'DU-test' },
        ...(positionClose ? { options: { quantity: record.quantity } } : { draft: record }),
      },
      { 'x-tradescript-connection': originalGeneration },
    )
    const ownerId = result.attemptId!
    record.customFields = { [PAPER_OWNER_FIELD]: ownerId }
    record.brokerOrderRef = `tspe:${ownerId}:${record.brokerOrderId ?? 100}`
    snapshots.set(ownerId, {
      ownerId,
      orders: [record],
      executions: [],
      reconciled: true,
      outcome: 'known',
    })
    return { ...result, path, ownerId }
  }
  return { tracker, state, snapshots, closes, calls, cancelled, probe, session, prepare }
}
test('durable exact ownership survives empty gateway history and changed authentication generation', async () => {
  const h = transportHarness(),
    entry = ordinary('entry', 'buy', 2, { brokerOrderId: 100, clientId: 17, permId: 700 })
  const prepared = h.prepare(entry, 'old-generation')
  try {
    await h.tracker.recordResponse(
      response({ order: entry }, 201, prepared.path),
      'POST',
      prepared.attemptId,
    )
    await h.tracker.cleanup(h.probe, h.session)
    assert.deepEqual(
      h.closes.map((draft) => [draft.symbol.contractIdentity?.conId, draft.side, draft.quantity]),
      [[101, 'sell', 2]],
    )
    assert.equal(
      h.calls.some((call) => call.endsWith(`/paper-ownership/${prepared.ownerId}`)),
      true,
    )
  } finally {
    h.tracker.dispose()
  }
})
test('a lost position-close response recovers only its pre-dispatch carrier from durable ownership', async () => {
  const h = transportHarness(),
    entry = ordinary('entry', 'buy', 2),
    close = ordinary('position-close', 'sell', 2)
  const entryAttempt = h.prepare(entry),
    closeAttempt = h.prepare(close, 'new-generation', true)
  try {
    await h.tracker.recordResponse(
      response({ order: entry }, 201, entryAttempt.path),
      'POST',
      entryAttempt.attemptId,
    )
    assert.equal(
      (closeAttempt.body as { options: { paperOwnershipId: string } }).options.paperOwnershipId,
      closeAttempt.ownerId,
    )
    await h.tracker.cleanup(h.probe, h.session)
    assert.deepEqual(h.closes, [])
    assert.equal(
      h.calls.some((call) => call.endsWith(`/paper-ownership/${closeAttempt.ownerId}`)),
      true,
    )
  } finally {
    h.tracker.dispose()
  }
})
test('a durable working order missing from gateway state is cancelled before exact partial-fill recovery', async () => {
  const h = transportHarness(),
    entry = ordinary('entry', 'buy', 4, { status: 'working', filledQuantity: 1 })
  h.prepare(entry, 'old-generation')
  try {
    await h.tracker.cleanup(h.probe, h.session)
    assert.deepEqual(h.cancelled, ['entry'])
    assert.deepEqual(
      h.closes.map((draft) => [draft.side, draft.quantity]),
      [['sell', 1]],
    )
  } finally {
    h.tracker.dispose()
  }
})
for (const fault of [
  'wrong-owner',
  'unreconciled',
  'unknown-outcome',
  'wrong-native-ref',
  'wrong-account',
] as const)
  test(`durable recovery refuses ${fault} while leaving unrelated state untouched`, async () => {
    const h = transportHarness(),
      entry = ordinary('entry', 'buy', 2),
      prepared = h.prepare(entry, 'old-generation')
    const snapshot = h.snapshots.get(prepared.ownerId)!
    if (fault === 'wrong-owner') snapshot.ownerId = randomUUID()
    if (fault === 'unreconciled') snapshot.reconciled = false
    if (fault === 'unknown-outcome') snapshot.outcome = 'unknown'
    if (fault === 'wrong-native-ref') entry.brokerOrderRef = `tspe:${randomUUID()}:100`
    if (fault === 'wrong-account') entry.accountId = 'DU-other'
    const unrelated = ordinary('unrelated', 'buy', 99)
    h.state.ordersHistory!.push(unrelated)
    try {
      await assert.rejects(h.tracker.cleanup(h.probe, h.session))
      assert.deepEqual(h.closes, [])
      assert.deepEqual(h.state.ordersHistory, [unrelated])
    } finally {
      h.tracker.dispose()
    }
  })
