import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Execution, Order } from '@ibkr-terminal/contracts'
import {
  type Contract,
  EventName,
  type IBApi,
  OrderAction,
  OrderType,
  SecType,
  TimeInForce,
} from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { fromIbSymbol } from '../src/ibkr/contracts.js'
import { OrderExecution } from '../src/ibkr/order-execution.js'
import { PAPER_OWNER_FIELD, PaperOwnershipJournal } from '../src/ibkr/paper-ownership-journal.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

const scope = { host: '127.0.0.1', port: 7497, clientId: 17, environment: 'paper' as const }
const native: Contract = {
  conId: 101,
  symbol: 'TEST',
  secType: SecType.STK,
  exchange: 'SMART',
  currency: 'USD',
}
const symbol = {
  symbol: 'TEST',
  canonicalSymbol: 'IBKR:101',
  assetClass: 'stock',
  exchange: 'SMART',
  currency: 'USD',
  contractIdentity: { conId: 101, securityType: 'STK' },
}
const directories: string[] = []
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'paper-owner-test-'))
  directories.push(path)
  return path
}
const intent = (ownerId = randomUUID(), extra: Partial<Order> = {}): Order => ({
  id: '100',
  brokerOrderId: 100,
  accountId: 'DU-test',
  symbol,
  side: 'buy',
  type: 'limit',
  duration: 'day',
  quantity: 4,
  limitPrice: 1,
  status: 'placing',
  submittedAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  customFields: { [PAPER_OWNER_FIELD]: ownerId },
  ...extra,
})
const fill = (prepared: Order, extra: Partial<Execution> = {}): Execution => ({
  id: 'native-fill.01',
  orderId: prepared.id,
  brokerOrderId: prepared.brokerOrderId,
  brokerOrderRef: prepared.brokerOrderRef,
  clientId: 17,
  permId: 777,
  accountId: 'DU-test',
  symbol,
  side: 'buy',
  quantity: 1,
  cumulativeQuantity: 1,
  price: 1,
  timestamp: '',
  ...extra,
})
afterEach(() => {
  vi.useRealTimers()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('durable exact paper ownership journal', () => {
  it('persists before dispatch and restores working intent only as unconfirmed', () => {
    const path = directory(),
      journal = new PaperOwnershipJournal(path, scope),
      prepared = journal.prepare(intent(), native)
    expect(prepared.brokerOrderRef).toBe(`tspe:${prepared.customFields![PAPER_OWNER_FIELD]}:100`)
    expect(statSync(journal.path).mode & 0o777).toBe(0o600)
    const restarted = new PaperOwnershipJournal(path, scope)
    expect(restarted.restored().orders[0]).toMatchObject({
      status: 'inactive',
      customFields: { ibkrMissingOpenOrder: true },
    })
    expect(restarted.recovery(String(prepared.customFields![PAPER_OWNER_FIELD]))).toMatchObject({
      reconciled: false,
      outcome: 'unknown',
    })
  })
  it('does not bind a reused API id or arbitrary native reference', () => {
    const journal = new PaperOwnershipJournal(directory(), scope),
      prepared = journal.prepare(intent(), native)
    expect(
      journal.adoptOrder({ ...prepared, brokerOrderRef: undefined, permId: undefined }),
    ).toBeUndefined()
    expect(
      journal.adoptOrder({ ...prepared, brokerOrderRef: `tspe:${randomUUID()}:100` }),
    ).toBeUndefined()
    expect(journal.recovery(String(prepared.customFields![PAPER_OWNER_FIELD])).outcome).toBe(
      'unknown',
    )
  })
  it('adopts only exact account/client/contract and then permanent broker binding', () => {
    const path = directory(),
      journal = new PaperOwnershipJournal(path, scope),
      prepared = journal.prepare(intent(), native)
    for (const wrong of [
      { accountId: 'DU-other' },
      { clientId: 18 },
      { side: 'sell' as const },
      { symbol: { ...symbol, contractIdentity: { conId: 102, securityType: 'STK' } } },
    ])
      expect(() => journal.adoptOrder({ ...prepared, ...wrong })).toThrow(/contradicts/)
    const seen = journal.adoptOrder({ ...prepared, permId: 777, status: 'working' })!
    journal.recordOrder(seen, true)
    const restarted = new PaperOwnershipJournal(path, scope)
    expect(
      restarted.adoptOrder({ ...seen, brokerOrderRef: undefined, brokerOrderId: 200 })?.id,
    ).toBe('100')
    expect(() => restarted.adoptOrder({ ...seen, permId: 778 })).toThrow(/contradicts/)
    restarted.finishReconciliation()
    expect(restarted.recovery(String(prepared.customFields![PAPER_OWNER_FIELD])).outcome).toBe(
      'unknown',
    )
    restarted.recordOrder(
      {
        ...restarted.adoptOrder({ ...seen, brokerOrderRef: undefined, brokerOrderId: 200 })!,
        customFields: { ...seen.customFields, ibkrMissingOpenOrder: false },
      },
      true,
    )
    expect(restarted.recovery(String(prepared.customFields![PAPER_OWNER_FIELD])).outcome).toBe(
      'known',
    )
  })
  it('rejects independent reuse of a UUID but journals exact native children', () => {
    const journal = new PaperOwnershipJournal(directory(), scope),
      draft = intent(),
      parent = journal.prepare(draft, native)
    expect(() => journal.prepare({ ...draft, id: '101', brokerOrderId: 101 }, native)).toThrow(
      /reused/,
    )
    const child = journal.prepare(
      { ...draft, id: '102', brokerOrderId: 102, parentId: parent.id, side: 'sell' },
      native,
    )
    expect(child.brokerOrderRef).not.toBe(parent.brokerOrderRef)
    expect(journal.recovery(String(parent.customFields![PAPER_OWNER_FIELD])).orders).toHaveLength(2)
  })
  it('retains revised executions across restart without receive-time fabrication', () => {
    const path = directory(),
      journal = new PaperOwnershipJournal(path, scope),
      prepared = journal.prepare(intent(), native)
    journal.recordExecution(fill(prepared))
    journal.recordExecution(
      fill(prepared, { id: 'native-fill.02', quantity: 2, cumulativeQuantity: 2 }),
    )
    expect(journal.recordExecution(fill(prepared, { id: 'native-fill.01' }))).toBeUndefined()
    const restarted = new PaperOwnershipJournal(path, scope)
    expect(restarted.restored().executions).toMatchObject([
      { id: 'native-fill.02', quantity: 2, timestamp: '' },
    ])
    expect(() =>
      restarted.recordExecution(
        fill(prepared, {
          id: 'native-fill.03',
          symbol: { ...symbol, contractIdentity: { conId: 999, securityType: 'STK' } },
        }),
      ),
    ).toThrow(/contradicts/)
  })
  it('does not permit native target or ownership changes during modification', () => {
    const journal = new PaperOwnershipJournal(directory(), scope),
      prepared = journal.prepare(intent(), native)
    expect(() => journal.assertModification(prepared, { ...native, conId: 102 })).toThrow(
      /immutable/,
    )
    expect(() => journal.assertModification({ ...prepared, customFields: {} }, native)).toThrow(
      /immutable/,
    )
    expect(() => journal.assertModification({ ...prepared, side: 'sell' }, native)).toThrow(
      /immutable/,
    )
    expect(() => journal.assertModification({ ...prepared, quantity: 5 }, native)).not.toThrow()
  })
  it('fails closed on corrupt, public or ambiguous persisted authority', () => {
    const path = directory(),
      journal = new PaperOwnershipJournal(path, scope)
    journal.prepare(intent(), native)
    chmodSync(journal.path, 0o644)
    expect(() => new PaperOwnershipJournal(path, scope)).toThrow(/private/)
    chmodSync(journal.path, 0o600)
    const data = JSON.parse(readFileSync(journal.path, 'utf8'))
    data.entries.push(data.entries[0])
    writeFileSync(journal.path, JSON.stringify(data), { mode: 0o600 })
    expect(() => new PaperOwnershipJournal(path, scope)).toThrow(/ambiguous/)
    writeFileSync(journal.path, '{', { mode: 0o600 })
    expect(() => new PaperOwnershipJournal(path, scope)).toThrow()
  })
  it('latches write failure and reports unknown instead of continuing owned dispatch', () => {
    const journal = new PaperOwnershipJournal(directory(), scope),
      prepared = journal.prepare(intent(), native)
    unlinkSync(journal.path)
    mkdirSync(journal.path)
    expect(() => journal.recordOrder({ ...prepared, status: 'working' }, true)).toThrow(
      /outcome remains unknown/,
    )
    expect(() =>
      journal.prepare(intent(randomUUID(), { id: '101', brokerOrderId: 101 }), native),
    ).toThrow(/dispatch is blocked/)
    expect(journal.recovery(String(prepared.customFields![PAPER_OWNER_FIELD])).outcome).toBe(
      'unknown',
    )
  })
  it('keeps different paper connection scopes isolated', () => {
    const path = directory(),
      journal = new PaperOwnershipJournal(path, scope),
      prepared = journal.prepare(intent(), native)
    expect(() =>
      new PaperOwnershipJournal(path, { ...scope, clientId: 18 }).recovery(
        String(prepared.customFields![PAPER_OWNER_FIELD]),
      ),
    ).toThrow(/No durable/)
  })
})

function executionFixture(
  path = directory(),
  environment: 'paper' | 'live' = 'paper',
  allowedAccounts = 'DU-test',
) {
  const api = Object.assign(new EventEmitter(), {
    placeOrder: vi.fn(),
    reqExecutions: vi.fn(),
  }) as unknown as IBApi
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const journal = new PaperOwnershipJournal(path, scope)
  const requests = { requestContractDetails: vi.fn() }
  const executor = new OrderExecution(
    api,
    createBridgeConfig(
      loadGatewayConfig({
        IBKR_CLIENT_ID: '17',
        IBKR_ALLOWED_ACCOUNT_IDS: allowedAccounts,
        IBKR_EXECUTION_ENVIRONMENT: environment,
      }),
    ),
    store,
    requests,
    undefined,
    undefined,
    journal,
  )
  api.emit(EventName.nextValidId, 100)
  vi.spyOn(executor, 'previewOrder').mockResolvedValue({ accepted: true })
  return { api, store, journal, executor, path, requests }
}
function acknowledge(api: IBApi, prepared: Order, status = 'Submitted') {
  api.emit(
    EventName.openOrder,
    prepared.brokerOrderId,
    native,
    {
      orderId: prepared.brokerOrderId,
      clientId: 17,
      permId: 777,
      orderRef: prepared.brokerOrderRef,
      account: 'DU-test',
      action: OrderAction.BUY,
      orderType: OrderType.LMT,
      tif: TimeInForce.DAY,
      totalQuantity: 4,
    },
    { status },
  )
}
describe('native ownership dispatch and acknowledgement integration', () => {
  it('sends a durable native orderRef before socket placement', async () => {
    const { api, executor, journal } = executionFixture(),
      draft = intent()
    const placed = await executor.placeOrder(draft, { accountId: 'DU-test' })
    expect(api.placeOrder).toHaveBeenCalledOnce()
    expect(vi.mocked(api.placeOrder).mock.calls[0]![2].orderRef).toBe(placed.order!.brokerOrderRef)
    expect(
      new PaperOwnershipJournal(dirnameFor(journal.path), scope).restored().orders,
    ).toHaveLength(1)
  })
  it('blocks native dispatch when durable preparation fails', async () => {
    const { api, executor, journal } = executionFixture()
    mkdirSync(journal.path, { recursive: true })
    await expect(executor.placeOrder(intent(), { accountId: 'DU-test' })).rejects.toThrow(
      /dispatch is blocked/,
    )
    expect(api.placeOrder).not.toHaveBeenCalled()
  })
  it('recovers an exact acknowledged order after fresh gateway/history restart', async () => {
    const first = executionFixture(),
      placed = (await first.executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    acknowledge(first.api, placed)
    const next = executionFixture(first.path)
    expect(next.store.getState().orders[0]).toMatchObject({
      status: 'inactive',
      customFields: { ibkrMissingOpenOrder: true },
    })
    acknowledge(next.api, placed)
    next.executor.finishReconciliation()
    expect(
      next.executor.paperOwnershipRecovery(String(placed.customFields![PAPER_OWNER_FIELD])),
    ).toMatchObject({
      reconciled: true,
      outcome: 'known',
      orders: [{ id: placed.id, status: 'working' }],
    })
  })
  it('never advertises saved working readiness after restart without a fresh native acknowledgement', async () => {
    const first = executionFixture(),
      placed = (await first.executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    acknowledge(first.api, placed)
    const next = executionFixture(first.path)
    next.executor.finishReconciliation()
    expect(
      next.executor.paperOwnershipRecovery(String(placed.customFields![PAPER_OWNER_FIELD])).outcome,
    ).toBe('unknown')
  })
  it('does not expose durable orders when the current paper profile disallows their account', async () => {
    const first = executionFixture(),
      placed = (await first.executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    acknowledge(first.api, placed)
    const next = executionFixture(first.path, 'paper', 'DU-other')
    expect(() =>
      next.executor.paperOwnershipRecovery(String(placed.customFields![PAPER_OWNER_FIELD])),
    ).toThrow(/not authorized/)
    await expect(
      next.executor.reconcilePaperOwnership(String(placed.customFields![PAPER_OWNER_FIELD])),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
  it('fresh exact completed-order acknowledgement clears restored missing-open uncertainty', async () => {
    const first = executionFixture(),
      placed = (await first.executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    acknowledge(first.api, placed)
    const next = executionFixture(first.path)
    next.api.emit(
      EventName.completedOrder,
      native,
      {
        orderId: 100,
        clientId: 17,
        permId: 777,
        orderRef: placed.brokerOrderRef,
        account: 'DU-test',
        action: OrderAction.BUY,
        orderType: OrderType.LMT,
        tif: TimeInForce.DAY,
        totalQuantity: 4,
      },
      { status: 'Filled', completedStatus: 'Filled' },
    )
    next.executor.finishReconciliation()
    expect(
      next.executor.paperOwnershipRecovery(String(placed.customFields![PAPER_OWNER_FIELD])),
    ).toMatchObject({
      outcome: 'known',
      orders: [
        { status: 'filled', filledQuantity: 4, customFields: { ibkrMissingOpenOrder: false } },
      ],
    })
  })
  it('does not let reused old API callbacks rebind a restored ownership intent', async () => {
    const first = executionFixture(),
      placed = (await first.executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    const next = executionFixture(first.path)
    next.api.emit(EventName.orderStatus, 100, 'Filled', 4, 0, 1, 999, 0, 1, 17)
    acknowledge(next.api, { ...placed, brokerOrderRef: undefined })
    expect(next.store.getState().orders.find((o) => o.id === placed.id)?.status).toBe('inactive')
    expect(
      next.store.getState().orders.find((o) => o.id === placed.id)?.customFields
        ?.ibkrMissingOpenOrder,
    ).toBe(true)
  })
  it('requires matching bounded execution-end evidence before claiming replay complete', async () => {
    const { api, executor } = executionFixture(),
      placed = (await executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    acknowledge(api, placed, 'Filled')
    api.emit(EventName.orderStatus, 100, 'Filled', 4, 0, 1, 777, 0, 1, 17)
    executor.finishReconciliation()
    vi.mocked(api.reqExecutions).mockImplementation((id) => {
      queueMicrotask(() => {
        api.emit(EventName.execDetailsEnd, id + 1)
        api.emit(EventName.execDetailsEnd, id)
      })
    })
    expect(
      (await executor.reconcilePaperOwnership(String(placed.customFields![PAPER_OWNER_FIELD])))
        .executionsReconciled,
    ).toBe(true)
  })
  it('does not leak stale owned execution corrections into an unrelated order identity', async () => {
    const { api, executor, store } = executionFixture(),
      prepared = (await executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    acknowledge(api, prepared)
    for (const [execId, shares] of [
      ['native-revision.02', 2],
      ['native-revision.01', 1],
    ] as const)
      api.emit(EventName.execDetails, 1, native, {
        execId,
        acctNumber: 'DU-test',
        orderId: 100,
        clientId: 17,
        permId: 777,
        orderRef: prepared.brokerOrderRef,
        side: 'BOT',
        shares,
        cumQty: shares,
        price: 1,
        time: '',
      })
    expect(store.getState().executions).toMatchObject([
      { id: 'native-revision.02', orderId: prepared.id, quantity: 2 },
    ])
    expect(store.getState().executions).toHaveLength(1)
  })
  it('preserves an ownership carrier on generated position-close draft', async () => {
    const { executor, store } = executionFixture(),
      ownerId = randomUUID()
    store.upsertPosition({ id: 'position-test', accountId: 'DU-test', symbol, quantity: 3 })
    const placed = await executor.closePosition(
      'position-test',
      { accountId: 'DU-test' },
      { quantity: 1, paperOwnershipId: ownerId },
    )
    expect(placed.order).toMatchObject({
      side: 'sell',
      quantity: 1,
      customFields: { [PAPER_OWNER_FIELD]: ownerId },
    })
    expect(placed.order?.brokerOrderRef).toContain(ownerId)
  })
  it('rejects malformed and Live close ownership carriers with a client error before dispatch', async () => {
    for (const [environment, ownerId] of [
      ['paper', 'invalid'],
      ['live', randomUUID()],
    ] as const) {
      const { executor, api, store } = executionFixture(directory(), environment)
      store.upsertPosition({ id: 'position-test', accountId: 'DU-test', symbol, quantity: 3 })
      await expect(
        executor.closePosition(
          'position-test',
          { accountId: 'DU-test' },
          { paperOwnershipId: ownerId },
        ),
      ).rejects.toMatchObject({ statusCode: 400 })
      expect(api.placeOrder).not.toHaveBeenCalled()
    }
  })
  it('refuses a runtime modification which replaces the immutable native ownership reference', async () => {
    const { api, executor } = executionFixture(),
      prepared = (await executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    acknowledge(api, prepared)
    const patch = { quantity: 4, brokerOrderRef: 'foreign-reference' }
    await expect(
      executor.modifyOrder(prepared.id, patch, { accountId: 'DU-test' }),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(api.placeOrder).toHaveBeenCalledOnce()
  })
})
function dirnameFor(path: string): string {
  return join(path, '..')
}

const combo: Contract = {
  symbol: 'TEST',
  secType: SecType.BAG,
  exchange: 'SMART',
  currency: 'USD',
  comboLegs: [
    { conId: 201, ratio: 1, action: OrderAction.BUY, exchange: 'SMART' },
    { conId: 202, ratio: 2, action: OrderAction.SELL, exchange: 'SMART' },
  ],
}
const comboIntent = (): Order =>
  intent(randomUUID(), {
    optionLegs: [201, 202].map((conId, index) => ({
      contract: {
        underlying: 'TEST',
        underlyingSymbolInfo: symbol,
        brokerContractId: conId,
        expiration: '20261218',
        strike: 200 + index,
        right: 'call',
        multiplier: 100,
        currency: 'USD',
      },
      side: index === 0 ? 'buy' : 'sell',
      quantity: index === 0 ? 4 : 8,
      ratio: index === 0 ? 1 : 2,
      positionEffect: 'open',
    })),
  })
const providerLegs: Contract[] = [201, 202].map((conId, index) => ({
  conId,
  symbol: 'TEST',
  secType: SecType.OPT,
  currency: 'USD',
  exchange: 'SMART',
  lastTradeDateOrContractMonth: '20261218',
  strike: 200 + index,
  right: 'C',
  multiplier: 100,
}))
describe('complete native leg coverage checkpoints', () => {
  it('retains only qualified provider leg terms across restart without filling missing class/account/currency', () => {
    const path = directory(),
      journal = new PaperOwnershipJournal(path, scope)
    const prepared = journal.prepare(comboIntent(), combo, providerLegs)
    const restarted = new PaperOwnershipJournal(path, scope)
    const incoming = fill(prepared, {
      symbol: fromIbSymbol({ conId: 201, symbol: 'TEST', secType: SecType.OPT, currency: 'USD' }),
    })
    expect(restarted.recordExecution(incoming)?.symbol.contractIdentity).toMatchObject({
      conId: 201,
      securityType: 'OPT',
      expiry: '20261218',
      strike: 200,
      right: 'C',
      multiplier: 100,
    })
    for (const wrong of [
      {
        ...incoming,
        id: 'wrong-class.01',
        symbol: fromIbSymbol({ conId: 201, symbol: 'TEST', secType: SecType.FUT, currency: 'USD' }),
      },
      { ...incoming, id: 'wrong-currency.01', symbol: { ...incoming.symbol, currency: undefined } },
      { ...incoming, id: 'wrong-account.01', accountId: undefined },
      {
        ...incoming,
        id: 'wrong-strike.01',
        symbol: {
          ...incoming.symbol,
          contractIdentity: { ...incoming.symbol.contractIdentity!, strike: 999 },
        },
      },
    ])
      expect(() => restarted.recordExecution(wrong)).toThrow(/contradict/)
    const malformed = JSON.parse(readFileSync(restarted.path, 'utf8'))
    malformed.entries[0].resolvedContracts[0].contractIdentity.conId = 999
    writeFileSync(restarted.path, JSON.stringify(malformed), { mode: 0o600 })
    expect(() => new PaperOwnershipJournal(path, scope)).toThrow(/malformed provider/)
  })
  it('retains actual ContractDetails provenance through native combo dispatch and incomplete leg callbacks', async () => {
    const { executor, api, store, requests } = executionFixture()
    requests.requestContractDetails.mockImplementation(async (query: Contract) => [
      { contract: providerLegs.find((contract) => contract.conId === query.conId)! },
    ])
    const prepared = (await executor.placeOrder(comboIntent(), { accountId: 'DU-test' })).order!
    api.emit(
      EventName.openOrder,
      100,
      combo,
      {
        orderId: 100,
        clientId: 17,
        permId: 777,
        orderRef: prepared.brokerOrderRef,
        account: 'DU-test',
        action: OrderAction.BUY,
        orderType: OrderType.LMT,
        tif: TimeInForce.DAY,
        totalQuantity: 4,
      },
      { status: 'Submitted' },
    )
    api.emit(
      EventName.execDetails,
      1,
      { conId: 201, symbol: 'TEST', secType: SecType.OPT, currency: 'USD' },
      {
        execId: 'leg-native.01',
        acctNumber: 'DU-test',
        orderId: 100,
        clientId: 17,
        permId: 777,
        orderRef: prepared.brokerOrderRef,
        side: 'BOT',
        shares: 1,
        cumQty: 1,
        price: 1,
        time: '',
      },
    )
    expect(store.getState().executions[0]?.symbol.contractIdentity).toMatchObject({
      conId: 201,
      expiry: '20261218',
      strike: 200,
      right: 'C',
      multiplier: 100,
    })
  })
  it('checks the actual incoming native combo legs before adopting retained intent', () => {
    const journal = new PaperOwnershipJournal(directory(), scope),
      prepared = journal.prepare(comboIntent(), combo)
    const incoming = { ...prepared, symbol: fromIbSymbol(combo), permId: 777 }
    expect(() => journal.adoptOrder(incoming)).toThrow(/omitted/)
    expect(() =>
      journal.adoptOrder(incoming, {
        ...combo,
        comboLegs: [{ ...combo.comboLegs![0]!, conId: 999 }, combo.comboLegs![1]!],
      }),
    ).toThrow(/leg structure/)
    expect(journal.adoptOrder(incoming, combo)?.optionLegs).toEqual(prepared.optionLegs)
  })
  it('persists zero/absent-leg coverage only after uninterrupted dispatch, terminal ack and replay end', () => {
    const path = directory(),
      journal = new PaperOwnershipJournal(path, scope)
    journal.finishReconciliation()
    const prepared = journal.prepare(comboIntent(), combo)
    journal.recordOrder(
      {
        ...journal.adoptOrder({ ...prepared, symbol: fromIbSymbol(combo), permId: 777 }, combo)!,
        status: 'cancelled',
        filledQuantity: 0,
      },
      true,
    )
    const id = String(prepared.customFields![PAPER_OWNER_FIELD])
    expect(journal.recovery(id).executionCoverageFromDispatch).toBe(false)
    journal.finishExecutionReplay(id)
    expect(journal.recovery(id).executionCoverageFromDispatch).toBe(true)
    expect(new PaperOwnershipJournal(path, scope).recovery(id).executionCoverageFromDispatch).toBe(
      true,
    )
  })
  it('never treats restarted/interrupted intents as complete historical absence', () => {
    const path = directory(),
      journal = new PaperOwnershipJournal(path, scope)
    journal.finishReconciliation()
    const prepared = journal.prepare(comboIntent(), combo),
      id = String(prepared.customFields![PAPER_OWNER_FIELD])
    const restarted = new PaperOwnershipJournal(path, scope)
    restarted.finishReconciliation()
    restarted.recordOrder(
      {
        ...restarted.adoptOrder({ ...prepared, symbol: fromIbSymbol(combo), permId: 777 }, combo)!,
        status: 'cancelled',
        filledQuantity: 0,
      },
      true,
    )
    restarted.finishExecutionReplay(id)
    expect(restarted.recovery(id)).toMatchObject({
      executionsReconciled: true,
      executionCoverageFromDispatch: false,
    })
    journal.beginReconciliation()
    journal.finishReconciliation()
    journal.recordOrder({ ...prepared, status: 'cancelled', filledQuantity: 0, permId: 777 }, true)
    journal.finishExecutionReplay(id)
    expect(journal.recovery(id).executionCoverageFromDispatch).toBe(false)
  })
  it('invalidates a completed checkpoint when a revised execution arrives', () => {
    const journal = new PaperOwnershipJournal(directory(), scope)
    journal.finishReconciliation()
    const prepared = journal.prepare(intent(), native),
      id = String(prepared.customFields![PAPER_OWNER_FIELD])
    journal.recordOrder({ ...prepared, status: 'cancelled', permId: 777, filledQuantity: 1 }, true)
    journal.recordExecution(fill(prepared))
    journal.finishExecutionReplay(id)
    expect(journal.recovery(id).executionCoverageFromDispatch).toBe(true)
    journal.recordExecution(fill(prepared, { id: 'native-fill.02', price: 2 }))
    expect(journal.recovery(id)).toMatchObject({
      executionsReconciled: false,
      executionCoverageFromDispatch: false,
    })
  })
  it('rejects malformed nested native/execution facts on restart', () => {
    const path = directory(),
      journal = new PaperOwnershipJournal(path, scope),
      prepared = journal.prepare(intent(), native)
    journal.recordExecution(fill(prepared))
    const data = JSON.parse(readFileSync(journal.path, 'utf8'))
    data.entries[0].executions[0].quantity = -1
    writeFileSync(journal.path, JSON.stringify(data), { mode: 0o600 })
    expect(() => new PaperOwnershipJournal(path, scope)).toThrow(/malformed native execution/)
  })
  it('turns contradictory native callbacks into unknown recovery without throwing from the emitter', async () => {
    const { api, executor, store } = executionFixture(),
      prepared = (await executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    expect(() =>
      api.emit(
        EventName.openOrder,
        100,
        { ...native, conId: 999 },
        {
          orderId: 100,
          clientId: 17,
          permId: 777,
          orderRef: prepared.brokerOrderRef,
          account: 'DU-test',
          action: OrderAction.BUY,
          orderType: OrderType.LMT,
          tif: TimeInForce.DAY,
          totalQuantity: 4,
        },
        { status: 'Submitted' },
      ),
    ).not.toThrow()
    expect(
      executor.paperOwnershipRecovery(String(prepared.customFields![PAPER_OWNER_FIELD])).outcome,
    ).toBe('unknown')
    expect(store.getState().orders[0]?.customFields?.ibkrOwnershipContradiction).toBe(true)
  })
  it('keeps an exact tagged contradictory side callback unknown without replacing direction', async () => {
    const { api, executor, store } = executionFixture(),
      prepared = (await executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    expect(() =>
      api.emit(
        EventName.openOrder,
        100,
        native,
        {
          orderId: 100,
          clientId: 17,
          permId: 777,
          orderRef: prepared.brokerOrderRef,
          account: 'DU-test',
          action: OrderAction.SELL,
          orderType: OrderType.LMT,
          tif: TimeInForce.DAY,
          totalQuantity: 4,
        },
        { status: 'Submitted' },
      ),
    ).not.toThrow()
    expect(
      executor.paperOwnershipRecovery(String(prepared.customFields![PAPER_OWNER_FIELD])).outcome,
    ).toBe('unknown')
    expect(store.getState().orders[0]?.side).toBe('buy')
  })
  it('refuses absent-leg coverage when a tagged execution omitted raw account authority', async () => {
    const { api, executor, journal } = executionFixture(),
      prepared = (await executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    acknowledge(api, prepared)
    expect(() =>
      api.emit(EventName.execDetails, 1, native, {
        execId: 'native-fill.01',
        orderId: 100,
        clientId: 17,
        permId: 777,
        orderRef: prepared.brokerOrderRef,
        side: 'BOT',
        shares: 1,
        cumQty: 1,
        price: 1,
        time: '',
      }),
    ).not.toThrow()
    expect(journal.recovery(String(prepared.customFields![PAPER_OWNER_FIELD])).outcome).toBe(
      'unknown',
    )
  })
  it('rejects a matching replay end if reconciliation changed while it was outstanding', async () => {
    const { api, executor } = executionFixture(),
      prepared = (await executor.placeOrder(intent(), { accountId: 'DU-test' })).order!
    acknowledge(api, prepared, 'Filled')
    api.emit(EventName.orderStatus, 100, 'Filled', 4, 0, 1, 777, 0, 1, 17)
    executor.finishReconciliation()
    vi.mocked(api.reqExecutions).mockImplementation((id) => {
      queueMicrotask(() => {
        executor.beginReconciliation()
        executor.finishReconciliation()
        api.emit(EventName.execDetailsEnd, id)
      })
    })
    await expect(
      executor.reconcilePaperOwnership(String(prepared.customFields![PAPER_OWNER_FIELD])),
    ).rejects.toThrow(/changed during/)
  })
})
