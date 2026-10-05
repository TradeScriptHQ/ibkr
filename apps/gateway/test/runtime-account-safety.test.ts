import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { type ContractDetails, EventName, type IBApi } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBrokerRuntime } from '../src/connections/broker-runtime.js'
import { toMarketSessionInfo } from '../src/ibkr/session-calendar.js'
import { buildSystemStatus } from '../src/status.js'

const { Decoder } = createRequire(import.meta.url)('@stoqey/ib/dist/core/io/decoder.js')
const runtimes: ReturnType<typeof createBrokerRuntime>[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture(environment: 'paper' | 'live' = 'paper', accounts = 'DU-TEST') {
  vi.useFakeTimers()
  const api = Object.assign(new EventEmitter(), {
    isConnected: false,
    connect: vi.fn(() => {
      api.isConnected = true
    }),
    disconnect: vi.fn(() => {
      api.isConnected = false
      api.emit(EventName.disconnected)
    }),
    reqManagedAccts: vi.fn(),
    reqAccountSummary: vi.fn(),
    cancelAccountSummary: vi.fn(),
    reqPositions: vi.fn(),
    reqAllOpenOrders: vi.fn(),
    reqCompletedOrders: vi.fn(),
    reqExecutions: vi.fn(),
    reqIds: vi.fn(),
    reqMarketDataType: vi.fn(),
    reqAccountUpdates: vi.fn(),
    reqPnL: vi.fn(),
    cancelPnL: vi.fn(),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    reqMktData: vi.fn(),
    cancelMktData: vi.fn(),
  })
  const config = loadGatewayConfig({
    IBKR_EXECUTION_ENVIRONMENT: environment,
    IBKR_ALLOWED_ACCOUNT_IDS: accounts,
    IBKR_CLIENT_ID: '7',
  })
  const runtime = createBrokerRuntime(config, vi.fn(), api as unknown as IBApi)
  runtimes.push(runtime)
  runtime.start()
  const begin = (managedAccounts = accounts) => {
    api.emit(EventName.connected)
    api.emit(EventName.managedAccounts, managedAccounts)
    api.emit(EventName.nextValidId, 100)
  }
  const finish = () => {
    api.emit(EventName.accountSummaryEnd, api.reqAccountSummary.mock.calls.at(-1)?.[0])
    api.emit(EventName.positionEnd)
    api.emit(EventName.openOrderEnd)
    api.emit(EventName.completedOrdersEnd)
    api.emit(EventName.execDetailsEnd, api.reqExecutions.mock.calls.at(-1)?.[0])
  }
  const info = (code: number, message = 'Synthetic broker system message') => {
    const decoder = new Decoder({
      serverVersion: 0,
      emitInfo: (value: string, errorCode: number) => api.emit(EventName.info, value, errorCode),
      emitError: (value: string, errorCode: number, reqId: number) =>
        api.emit(EventName.error, new Error(value), errorCode, reqId),
    })
    decoder.enqueueTokens(['2', '-1', String(code), message])
    decoder.processMsg(4)
  }
  return { api, runtime, config, begin, finish, info }
}

describe('broker runtime safety through real decoder system notifications', () => {
  it.each([1101, 1102])(
    'freezes on decoded 1100 and waits for complete fresh reconciliation after %s',
    (restoreCode) => {
      const { api, runtime, begin, finish, info } = fixture()
      begin()
      finish()
      const summaryId = api.reqAccountSummary.mock.calls.at(-1)?.[0]
      expect(runtime.tws.snapshot().state).toBe('ready')
      info(1100)
      expect(runtime.tws.snapshot().state).toBe('degraded')
      finish()
      api.emit(EventName.managedAccounts, 'DU-TEST')
      expect(runtime.tws.snapshot().state).toBe('degraded')
      expect(() => runtime.tws.allocateOrderId()).toThrow()
      info(restoreCode)
      api.emit(EventName.nextValidId, 200)
      expect(api.cancelAccountSummary).toHaveBeenCalledWith(summaryId)
      expect(runtime.tws.snapshot().state).toBe('reconciling')
      finish()
      expect(runtime.tws.snapshot().state).toBe('ready')
    },
  )

  it('does not let queued completion callbacks undo loss during the first reconciliation', () => {
    const { runtime, begin, finish, info } = fixture()
    begin()
    info(1100)
    finish()
    expect(runtime.tws.snapshot().state).toBe('degraded')
  })

  it('does not let cached ends restore readiness even through the legacy error notification path', () => {
    const { api, runtime, begin, finish } = fixture()
    begin()
    finish()
    api.emit(EventName.error, new Error('Synthetic provider loss'), 1100, -1)
    expect(runtime.tws.snapshot().state).toBe('degraded')
    finish()
    expect(runtime.tws.snapshot().state).toBe('degraded')
  })

  it('retries the configured client ID after a decoded conflict and reconciles before readiness', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { api, runtime, begin, finish, info } = fixture()
    info(326, 'Client identifier already in use')
    api.emit(EventName.disconnected)
    expect(runtime.tws.snapshot()).toMatchObject({
      state: 'disconnected',
      reconciliationComplete: false,
      lastErrorCode: 326,
      message: expect.stringContaining('7'),
    })
    expect(runtime.tws.snapshot().message).toMatch(/already in use/i)
    expect(runtime.tws.snapshot().connection.retry).toMatchObject({
      attempt: 1,
      maxAttempts: 5,
      exhausted: false,
    })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(999)
    expect(api.connect).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(api.connect).toHaveBeenCalledTimes(2)
    expect(api.connect).toHaveBeenLastCalledWith(7)
    begin()
    expect(runtime.tws.snapshot().state).toBe('reconciling')
    expect(() => runtime.tws.allocateOrderId()).toThrow()
    finish()
    expect(runtime.tws.snapshot().state).toBe('ready')
    runtime.stop()
    vi.advanceTimersByTime(60_000)
    expect(api.connect).toHaveBeenCalledTimes(2)
  })

  it('closes a pending handshake and ignores its late broker callbacks after stop', () => {
    const { api, runtime } = fixture()
    api.isConnected = false
    runtime.stop()
    expect(api.disconnect).toHaveBeenCalledOnce()
    api.emit(EventName.connected)
    api.emit(EventName.nextValidId, 300)
    api.emit(EventName.managedAccounts, 'DU-TEST')
    expect(api.reqPositions).not.toHaveBeenCalled()
    expect(runtime.tws.snapshot().state).toBe('disconnected')
    expect(runtime.tws.snapshot().socketConnected).toBe(false)
  })

  it.each([
    ['paper', 'U-TEST'],
    ['live', 'DU-TEST'],
  ] as const)(
    'refuses readiness for %s profile when the actual account is %s',
    (environment, account) => {
      const { runtime, config, begin, finish } = fixture(environment, account)
      begin()
      finish()
      expect(runtime.tws.snapshot().state).toBe('error')
      expect(
        buildSystemStatus(config, runtime.tws.snapshot(), {
          auditDatabaseReady: true,
          sdkInstalled: true,
          leaseReady: true,
        }).tradingEnabled,
      ).toBe(false)
    },
  )

  it.each([
    ['paper', 'DU-TEST'],
    ['live', 'U-TEST'],
  ] as const)(
    'accepts a matching %s account environment after reconciliation',
    (environment, account) => {
      const { runtime, begin, finish } = fixture(environment, account)
      begin()
      finish()
      expect(runtime.tws.snapshot().state).toBe('ready')
    },
  )
})

describe('account snapshot and portfolio safety', () => {
  const contract = {
    conId: 123,
    symbol: 'AAPL',
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
  }
  it('removes absent positions only after full reconnect reconciliation and refuses their close', async () => {
    const { api, runtime, begin, finish } = fixture()
    begin()
    api.emit(EventName.position, 'DU-TEST', contract, 5, 100)
    finish()
    const positionId = runtime.brokerStore.getState().positions[0]?.id
    expect(positionId).toBeDefined()
    api.isConnected = false
    api.emit(EventName.disconnected)
    begin()
    api.emit(EventName.positionEnd)
    expect(runtime.brokerStore.getState().positions).toHaveLength(1)
    finish()
    expect(runtime.brokerStore.getState().positions).toEqual([])
    await expect(runtime.ibkr.closePosition(String(positionId))).rejects.toThrow('was not found')
    expect(api.placeOrder).not.toHaveBeenCalled()
  })

  it('defaults to the first allowed managed account and drops removed accounts/selection', () => {
    const { api, runtime, begin, finish } = fixture('paper', 'DU-ALLOWED,DU-NEXT')
    begin('DU-DENIED,DU-ALLOWED,DU-NEXT')
    finish()
    expect(runtime.brokerStore.getState().activeAccountId).toBe('DU-ALLOWED')
    api.emit(EventName.managedAccounts, 'DU-DENIED,DU-NEXT')
    expect(runtime.brokerStore.getState().accounts.map((account) => account.id)).toEqual([
      'DU-DENIED',
      'DU-NEXT',
    ])
    expect(runtime.brokerStore.getState().activeAccountId).toBe('DU-NEXT')
  })

  it('invalidates quantity-dependent portfolio metrics on a quantity-only change while preserving fresh portfolio callbacks', () => {
    const { api, runtime, begin, finish } = fixture('paper', 'DU-TEST,DU-SECOND')
    begin()
    api.emit(EventName.updatePortfolio, contract, 10, 100, 1000, 90, 100, 50, 'DU-TEST')
    finish()
    runtime.ibkr.setActiveAccount('DU-SECOND')
    api.emit(EventName.position, 'DU-TEST', contract, 20, 90)
    expect(runtime.brokerStore.getState().positions[0]).toMatchObject({
      quantity: 20,
    })
    expect(runtime.brokerStore.getState().positions[0]?.marketValue).toBeUndefined()
    expect(runtime.brokerStore.getState().positions[0]?.unrealizedPnl).toBeUndefined()
    expect(runtime.brokerStore.getState().positions[0]?.realizedPnl).toBeUndefined()
    api.emit(EventName.updatePortfolio, contract, 20, 101, 2020, 90, 220, 50, 'DU-TEST')
    expect(runtime.brokerStore.getState().positions[0]).toMatchObject({
      marketValue: 2020,
      unrealizedPnl: 220,
    })
    api.emit(EventName.position, 'DU-TEST', contract, 20, 90)
    expect(runtime.brokerStore.getState().positions[0]?.marketValue).toBe(2020)
  })
})

it('does not let a regular-hours holiday hide an actual evening futures reopen', () => {
  const session = toMarketSessionInfo(
    { ticker: 'ES', type: 'futures', exchange: 'CME', currency: 'USD' },
    {
      contract: {
        symbol: 'ES',
        secType: 'FUT',
        exchange: 'CME',
        currency: 'USD',
      },
      timeZoneId: 'America/Chicago',
      tradingHours: '20260907:1700-20260908:1600',
      liquidHours: '20260907:CLOSED;20260908:0830-20260908:1500',
    } as ContractDetails,
    Date.parse('2026-09-07T23:00:00Z'),
  )
  expect(session.currentState).toBe('pre-market')
  expect(session.note).not.toBe('Closed by IBKR schedule')
  expect(
    session.upcoming.filter(
      (window) => window.opensAt <= session.asOf && window.closesAt > session.asOf,
    ),
  ).toEqual([expect.objectContaining({ state: 'pre-market' })])
})
