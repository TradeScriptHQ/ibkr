import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { OrderIdAllocator } from '../src/tws/order-id-allocator.js'
import { TwsSession } from '../src/tws/tws-session.js'

class FakeIbApi extends EventEmitter {
  isConnected = false
  readonly calls: string[] = []
  accountSummaryRequestId?: number
  executionRequestId?: number

  connect(clientId?: number) {
    this.calls.push(`connect:${clientId}`)
    this.isConnected = true
    return this
  }

  disconnect() {
    this.calls.push('disconnect')
    this.isConnected = false
    this.emit(EventName.disconnected)
    return this
  }

  reqManagedAccts() {
    this.calls.push('reqManagedAccts')
    return this
  }

  reqAccountSummary(requestId: number) {
    this.accountSummaryRequestId = requestId
    this.calls.push('reqAccountSummary')
    return this
  }

  cancelAccountSummary() {
    this.calls.push('cancelAccountSummary')
    return this
  }

  reqPositions() {
    this.calls.push('reqPositions')
    return this
  }

  reqAllOpenOrders() {
    this.calls.push('reqAllOpenOrders')
    return this
  }

  reqCompletedOrders() {
    this.calls.push('reqCompletedOrders')
    return this
  }

  reqExecutions(requestId: number) {
    this.executionRequestId = requestId
    this.calls.push('reqExecutions')
    return this
  }

  reqIds() {
    this.calls.push('reqIds')
    return this
  }
}

describe('TWS session state machine', () => {
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([
    ['ib-gateway', '4002', 'IB Gateway'],
    ['tws', '7497', 'TWS'],
  ])('bounds API startup for a connected %s session', (connectionType, port, label) => {
    vi.useFakeTimers()
    const fake = new FakeIbApi()
    const config = loadGatewayConfig({
      IBKR_CONNECTION_TYPE: connectionType,
      IBKR_PORT: port,
    })
    const session = new TwsSession(config.ibkr, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.connected)

    vi.advanceTimersByTime(4_999)
    expect(session.snapshot().state).toBe('connecting')
    vi.advanceTimersByTime(1)
    expect(session.snapshot()).toMatchObject({
      state: 'error',
      socketConnected: true,
      nextValidOrderIdReady: false,
      reconciliationComplete: false,
      message: `${label} connected, but its API did not complete startup within 5 seconds. ${label} may still show a healthy connection. Check ${label}, restart it if needed, then retry the workstation.`,
    })
    expect(fake.calls).toEqual(['connect:0'])
    session.disconnect()
  })

  it('accepts a late startup response through normal reconciliation after the timeout', () => {
    vi.useFakeTimers()
    const fake = new FakeIbApi()
    const session = new TwsSession(
      loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU12345' }).ibkr,
      fake as unknown as IBApi,
    )
    session.connect()
    fake.emit(EventName.connected)
    vi.advanceTimersByTime(5_000)
    expect(session.snapshot().state).toBe('error')

    fake.emit(EventName.nextValidId, 100)
    expect(session.snapshot().state).toBe('reconciling')
    fake.emit(EventName.managedAccounts, 'DU12345')
    fake.emit(EventName.accountSummaryEnd, fake.accountSummaryRequestId)
    fake.emit(EventName.positionEnd)
    fake.emit(EventName.openOrderEnd)
    fake.emit(EventName.completedOrdersEnd)
    fake.emit(EventName.execDetailsEnd, fake.executionRequestId)
    expect(session.snapshot()).toMatchObject({ state: 'ready', reconciliationComplete: true })
    session.disconnect()
  })

  it('cancels the startup deadline when reconciliation begins', () => {
    vi.useFakeTimers()
    const fake = new FakeIbApi()
    const session = new TwsSession(loadGatewayConfig({}).ibkr, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.connected)
    vi.advanceTimersByTime(4_000)
    fake.emit(EventName.nextValidId, 100)
    vi.advanceTimersByTime(1_001)
    expect(session.snapshot()).toMatchObject({
      state: 'reconciling',
      message: 'TWS protocol is ready; reconciling broker state.',
    })
    expect(vi.getTimerCount()).toBe(1)
    session.disconnect()
  })

  it('cancels the startup deadline on operator disconnect', () => {
    vi.useFakeTimers()
    const fake = new FakeIbApi()
    const session = new TwsSession(loadGatewayConfig({}).ibkr, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.connected)
    expect(vi.getTimerCount()).toBe(1)
    session.disconnect()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5_001)
    expect(session.snapshot()).toMatchObject({
      state: 'disconnected',
      message: 'TWS was disconnected by the local operator.',
    })
  })

  it('does not carry a startup deadline into a later socket connection', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const fake = new FakeIbApi()
    const session = new TwsSession(loadGatewayConfig({}).ibkr, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.connected)
    const firstGeneration = session.snapshot().generation
    vi.advanceTimersByTime(3_000)
    fake.emit(EventName.disconnected)
    expect(session.snapshot().generation).not.toBe(firstGeneration)
    vi.advanceTimersByTime(1_000)
    fake.emit(EventName.connected)

    vi.advanceTimersByTime(1_000)
    expect(session.snapshot().state).toBe('connecting')
    vi.advanceTimersByTime(3_999)
    expect(session.snapshot().state).toBe('connecting')
    vi.advanceTimersByTime(1)
    expect(session.snapshot().state).toBe('error')
    expect(fake.calls).toEqual(['connect:0', 'connect:0'])
    session.disconnect()
  })

  it.each([502, 504, 1100, 1101, 1102])(
    'cancels the startup deadline after provider state changes with code %s',
    (code) => {
      vi.useFakeTimers()
      const fake = new FakeIbApi()
      const session = new TwsSession(loadGatewayConfig({}).ibkr, fake as unknown as IBApi)
      session.connect()
      fake.emit(EventName.connected)
      expect(vi.getTimerCount()).toBe(1)
      fake.emit(EventName.error, new Error('Provider state changed'), code, -1)
      const providerState = session.snapshot()
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(5_001)
      expect(session.snapshot()).toEqual(providerState)
      session.disconnect()
    },
  )

  it.each([EventName.error, EventName.info])(
    'retries a conflicting client ID reported through %s and reconciles before becoming ready',
    (eventName) => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      const fake = new FakeIbApi()
      const session = new TwsSession(
        loadGatewayConfig({ IBKR_CLIENT_ID: '35299', IBKR_ALLOWED_ACCOUNT_IDS: 'DU12345' }).ibkr,
        fake as unknown as IBApi,
      )
      session.connect()
      fake.emit(EventName.connected)
      if (eventName === EventName.error)
        fake.emit(eventName, new Error('Client ID is already in use'), 326, -1)
      else fake.emit(eventName, 'Client ID is already in use', 326)

      expect(session.snapshot()).toMatchObject({
        state: 'disconnected',
        socketConnected: false,
        nextValidOrderIdReady: false,
        reconciliationComplete: false,
        lastErrorCode: 326,
        message: 'TWS client ID 35299 is already in use; check its sign-in and IBKR connection.',
      })
      expect(fake.calls).toEqual(['connect:35299', 'disconnect'])
      expect(vi.getTimerCount()).toBe(1)
      expect(() => session.allocateOrderId()).toThrow('reconciliation is complete')
      vi.advanceTimersByTime(999)
      expect(fake.calls).toEqual(['connect:35299', 'disconnect'])
      vi.advanceTimersByTime(1)
      expect(fake.calls).toEqual(['connect:35299', 'disconnect', 'connect:35299'])

      fake.emit(EventName.connected)
      fake.emit(EventName.managedAccounts, 'DU12345')
      fake.emit(EventName.nextValidId, 100)
      expect(session.snapshot().state).toBe('reconciling')
      expect(() => session.allocateOrderId()).toThrow('reconciliation is complete')
      fake.emit(EventName.accountSummaryEnd, fake.accountSummaryRequestId)
      fake.emit(EventName.positionEnd)
      fake.emit(EventName.openOrderEnd)
      fake.emit(EventName.completedOrdersEnd)
      fake.emit(EventName.execDetailsEnd, fake.executionRequestId)
      expect(session.snapshot()).toMatchObject({ state: 'ready', reconciliationComplete: true })
      expect(session.allocateOrderId()).toBeGreaterThanOrEqual(100)
      session.disconnect()
    },
  )

  it('increases backoff across rejected sockets and resets it only after broker readiness', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const fake = new FakeIbApi()
    const session = new TwsSession(
      loadGatewayConfig({ IBKR_CLIENT_ID: '35299', IBKR_ALLOWED_ACCOUNT_IDS: 'DU12345' }).ibkr,
      fake as unknown as IBApi,
    )
    session.connect()
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      fake.emit(EventName.connected)
      fake.emit(EventName.error, new Error('Client ID is already in use'), 326, -1)
      const connects = fake.calls.filter((call) => call.startsWith('connect:'))
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(delay - 1)
      expect(fake.calls.filter((call) => call.startsWith('connect:'))).toEqual(connects)
      vi.advanceTimersByTime(1)
      expect(fake.calls.filter((call) => call.startsWith('connect:'))).toEqual([
        ...connects,
        'connect:35299',
      ])
    }
    fake.emit(EventName.connected)
    fake.emit(EventName.managedAccounts, 'DU12345')
    fake.emit(EventName.nextValidId, 100)
    fake.emit(EventName.accountSummaryEnd, fake.accountSummaryRequestId)
    fake.emit(EventName.positionEnd)
    fake.emit(EventName.openOrderEnd)
    fake.emit(EventName.completedOrdersEnd)
    fake.emit(EventName.execDetailsEnd, fake.executionRequestId)
    expect(session.snapshot().state).toBe('ready')
    fake.emit(EventName.disconnected)
    const connects = fake.calls.filter((call) => call.startsWith('connect:'))
    vi.advanceTimersByTime(999)
    expect(fake.calls.filter((call) => call.startsWith('connect:'))).toEqual(connects)
    vi.advanceTimersByTime(1)
    expect(fake.calls.filter((call) => call.startsWith('connect:'))).toEqual([
      ...connects,
      'connect:35299',
    ])
    session.disconnect()
  })

  it('waits for the rejected socket to disconnect before scheduling a retry', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const fake = new FakeIbApi()
    vi.spyOn(fake, 'disconnect').mockImplementation(() => {
      fake.calls.push('disconnect')
      return fake
    })
    const session = new TwsSession(loadGatewayConfig({}).ibkr, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.connected)
    fake.emit(EventName.error, new Error('Client ID is already in use'), 326, -1)
    expect(fake.calls).toEqual(['connect:0', 'disconnect'])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(fake.calls).toEqual(['connect:0', 'disconnect'])
    fake.isConnected = false
    fake.emit(EventName.disconnected)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(fake.calls).toEqual(['connect:0', 'disconnect', 'connect:0'])
    session.disconnect()
  })

  it.each(['client-id-in-use', 'socket-disconnected'])(
    'stops after five automatic attempts for %s and lets the operator start a fresh cycle',
    (failure) => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      const fake = new FakeIbApi()
      const session = new TwsSession(
        loadGatewayConfig({ IBKR_CLIENT_ID: '35299' }).ibkr,
        fake as unknown as IBApi,
      )
      const fail = () => {
        fake.emit(EventName.connected)
        if (failure === 'client-id-in-use') fake.emit(EventName.info, 'Client ID in use', 326)
        else fake.disconnect()
      }
      session.connect()
      for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000].entries()) {
        fail()
        expect(session.snapshot().connection.retry).toMatchObject({
          attempt: index + 1,
          maxAttempts: 5,
          exhausted: false,
        })
        vi.advanceTimersByTime(delay)
      }
      fail()
      expect(session.snapshot()).toMatchObject({
        state: 'error',
        socketConnected: false,
        connection: { retry: { attempt: 5, maxAttempts: 5, exhausted: true, nextAttemptAt: null } },
      })
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(fake.calls.filter((call) => call.startsWith('connect:'))).toHaveLength(6)
      session.retryConnection()
      expect(fake.calls.filter((call) => call.startsWith('connect:'))).toHaveLength(7)
      expect(session.snapshot().connection.retry).toBeUndefined()
      fail()
      expect(session.snapshot().connection.retry).toMatchObject({
        attempt: 1,
        maxAttempts: 5,
        exhausted: false,
      })
      vi.advanceTimersByTime(1_000)
      expect(fake.calls.filter((call) => call.startsWith('connect:'))).toHaveLength(8)
      expect(fake.calls.filter((call) => call.startsWith('connect:'))).toEqual(
        Array(8).fill('connect:35299'),
      )
      session.disconnect()
      expect(session.snapshot().connection.retry).toBeUndefined()
    },
  )

  it('cancels a pending client-ID retry when the operator disconnects', () => {
    vi.useFakeTimers()
    const fake = new FakeIbApi()
    const session = new TwsSession(loadGatewayConfig({}).ibkr, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.connected)
    fake.emit(EventName.error, new Error('Client ID is already in use'), 326, -1)
    expect(vi.getTimerCount()).toBe(1)
    session.disconnect()
    expect(vi.getTimerCount()).toBe(0)
    expect(session.snapshot().connection.retry).toBeUndefined()
    expect(session.snapshot().connection.issue).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(fake.calls.filter((call) => call.startsWith('connect:'))).toEqual(['connect:0'])
  })

  it('publishes the actual retry deadline and clears the conflict after protocol acceptance', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'))
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const fake = new FakeIbApi()
    const session = new TwsSession(
      loadGatewayConfig({ IBKR_CONNECTION_TYPE: 'ib-gateway', IBKR_CLIENT_ID: '35299' }).ibkr,
      fake as unknown as IBApi,
    )
    const observed: unknown[] = []
    session.subscribe((snapshot) => observed.push(snapshot.connection))
    session.connect()
    fake.emit(EventName.connected)
    fake.emit(EventName.info, 'Client ID is already in use', 326)
    expect(observed.at(-1)).toEqual({
      connectionType: 'ib-gateway',
      clientId: 35299,
      issue: 'client-id-in-use',
      retry: {
        attempt: 1,
        maxAttempts: 5,
        exhausted: false,
        nextAttemptAt: '2026-10-04T12:00:01.000Z',
      },
    })
    vi.advanceTimersByTime(1_000)
    expect(session.snapshot().connection.retry).toEqual({
      attempt: 1,
      maxAttempts: 5,
      exhausted: false,
      nextAttemptAt: null,
    })
    fake.emit(EventName.connected)
    expect(session.snapshot().connection.issue).toBe('client-id-in-use')
    fake.emit(EventName.nextValidId, 100)
    expect(session.snapshot().connection.issue).toBeUndefined()
    expect(session.snapshot().state).toBe('reconciling')
    session.disconnect()
  })

  it('reports an IBKR outage only after the provider reports it and clears it on restoration', () => {
    const fake = new FakeIbApi()
    const session = new TwsSession(loadGatewayConfig({}).ibkr, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.connected)
    expect(session.snapshot().connection.issue).toBeUndefined()
    fake.emit(EventName.info, 'Connectivity between IB and TWS has been lost', 1100)
    expect(session.snapshot().connection.issue).toBe('ibkr-connectivity-lost')
    expect(session.snapshot().connection.retry).toBeUndefined()
    fake.emit(EventName.info, 'Connectivity restored', 1102)
    expect(session.snapshot().connection.issue).toBeUndefined()
    session.disconnect()
  })

  it('does not advertise an active retry after an accepted socket stops at the API startup deadline', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const fake = new FakeIbApi()
    const session = new TwsSession(loadGatewayConfig({}).ibkr, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.connected)
    fake.emit(EventName.info, 'Client ID already in use', 326)
    vi.advanceTimersByTime(1_000)
    fake.emit(EventName.connected)
    expect(session.snapshot().connection.retry).toEqual({
      attempt: 1,
      maxAttempts: 5,
      exhausted: false,
      nextAttemptAt: null,
    })
    vi.advanceTimersByTime(5_000)
    expect(session.snapshot().state).toBe('error')
    expect(session.snapshot().connection.retry).toBeUndefined()
    expect(session.snapshot().connection.issue).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    session.disconnect()
  })

  it('names the selected Gateway through connection and reconciliation on an advanced port', () => {
    const fake = new FakeIbApi()
    const config = loadGatewayConfig({
      IBKR_CONNECTION_TYPE: 'ib-gateway',
      IBKR_PORT: '4051',
      IBKR_ALLOWED_ACCOUNT_IDS: 'DU12345',
    })
    const session = new TwsSession(config.ibkr, fake as unknown as IBApi)
    expect(session.snapshot().message).toBe('IB Gateway is not connected.')
    session.connect()
    expect(session.snapshot().message).toBe('Connecting to the local IB Gateway paper session.')
    fake.emit(EventName.connected)
    fake.emit(EventName.managedAccounts, 'DU12345')
    fake.emit(EventName.nextValidId, 100)
    expect(session.snapshot().message).toBe(
      'IB Gateway protocol is ready; reconciling broker state.',
    )
    fake.emit(EventName.accountSummaryEnd, fake.accountSummaryRequestId)
    fake.emit(EventName.positionEnd)
    fake.emit(EventName.openOrderEnd)
    fake.emit(EventName.completedOrdersEnd)
    fake.emit(EventName.execDetailsEnd, fake.executionRequestId)
    expect(session.snapshot()).toMatchObject({
      state: 'ready',
      message: 'IB Gateway account state is reconciled.',
    })
    session.disconnect()
    expect(session.snapshot().message).toBe('IB Gateway was disconnected by the local operator.')
  })

  it('infers Gateway diagnostics for legacy port-only configuration', () => {
    const fake = new FakeIbApi()
    const config = { ...loadGatewayConfig({ IBKR_PORT: '4002' }).ibkr }
    delete config.connectionType
    const session = new TwsSession(config, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.error, new Error('Connection refused'), 502, -1)
    expect(session.snapshot().message).toBe(
      'Unable to connect to IB Gateway on the configured port.',
    )
    session.disconnect()
  })

  it('keeps reconciliation requests apart from broker orders and ignores prior generation endings', () => {
    const fake = new FakeIbApi()
    const ids = new OrderIdAllocator()
    const session = new TwsSession(
      loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU12345' }).ibkr,
      fake as unknown as IBApi,
      ids,
    )
    session.connect()
    fake.emit(EventName.connected)
    fake.emit(EventName.managedAccounts, 'DU12345')
    fake.emit(EventName.nextValidId, 900_005)
    const oldSummary = fake.accountSummaryRequestId
    const oldExecutions = fake.executionRequestId
    expect(oldSummary).not.toBe(900_001)
    expect(oldExecutions).not.toBe(900_002)
    expect(ids.ownsRequestId(Number(oldSummary))).toBe(true)
    expect(ids.ownsRequestId(Number(oldExecutions))).toBe(true)
    fake.emit(EventName.openOrder, 900_001, {}, { clientId: 0 }, {})
    fake.emit(EventName.openOrder, 900_002, {}, { clientId: 0 }, {})
    fake.emit(EventName.accountSummaryEnd, oldSummary)
    fake.emit(EventName.positionEnd)
    fake.emit(EventName.openOrderEnd)
    fake.emit(EventName.completedOrdersEnd)
    fake.emit(EventName.execDetailsEnd, oldExecutions)
    expect(session.snapshot().state).toBe('ready')
    const order = session.allocateOrderId()
    expect(order).toBeGreaterThan(900_005)
    expect(order).not.toBe(oldSummary)
    expect(order).not.toBe(oldExecutions)
    expect(ids.ownsRequestId(order)).toBe(false)

    session.disconnect()
    session.connect()
    fake.emit(EventName.connected)
    fake.emit(EventName.managedAccounts, 'DU12345')
    fake.emit(EventName.nextValidId, 900_005)
    expect(fake.accountSummaryRequestId).not.toBe(oldSummary)
    expect(fake.executionRequestId).not.toBe(oldExecutions)
    fake.emit(EventName.positionEnd)
    fake.emit(EventName.openOrderEnd)
    fake.emit(EventName.completedOrdersEnd)
    fake.emit(EventName.accountSummaryEnd, oldSummary)
    fake.emit(EventName.execDetailsEnd, oldExecutions)
    expect(session.snapshot().state).toBe('reconciling')
    fake.emit(EventName.accountSummaryEnd, fake.accountSummaryRequestId)
    fake.emit(EventName.execDetailsEnd, fake.executionRequestId)
    expect(session.snapshot().state).toBe('ready')
    session.disconnect()
  })

  it('waits for nextValidId and full reconciliation before becoming ready', () => {
    const fake = new FakeIbApi()
    const config = loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU12345' })
    const session = new TwsSession(config.ibkr, fake as unknown as IBApi)

    session.connect()
    fake.emit(EventName.connected)
    expect(session.snapshot().state).toBe('connecting')
    expect(fake.calls).toEqual(['connect:0'])

    fake.emit(EventName.managedAccounts, 'DU12345')
    fake.emit(EventName.nextValidId, 100)
    expect(session.snapshot().state).toBe('reconciling')
    expect(fake.calls).toContain('reqPositions')
    expect(fake.calls).toContain('reqAllOpenOrders')

    fake.emit(EventName.accountSummaryEnd, fake.accountSummaryRequestId)
    fake.emit(EventName.positionEnd)
    fake.emit(EventName.openOrder, 500, {}, { clientId: 0 }, {})
    fake.emit(EventName.openOrderEnd)
    fake.emit(EventName.completedOrdersEnd)
    fake.emit(EventName.execDetailsEnd, fake.executionRequestId)

    expect(session.snapshot()).toMatchObject({
      state: 'ready',
      reconciliationComplete: true,
      matchedAccountIds: ['DU12345'],
    })
    expect(session.allocateOrderId()).toBe(501)
    expect(session.allocateOrderId()).toBe(502)
    session.disconnect()
  })

  it('does not bind manual orders unless explicitly configured', () => {
    const fake = new FakeIbApi()
    const session = new TwsSession(loadGatewayConfig({}).ibkr, fake as unknown as IBApi)
    session.connect()
    fake.emit(EventName.connected)
    fake.emit(EventName.nextValidId, 1)
    expect(fake.calls).not.toContain('reqOpenOrders')
    expect(fake.calls).not.toContain('reqAutoOpenOrders')
    session.disconnect()
  })

  it('keeps the ready message when an individual market-data request is rejected', () => {
    const fake = new FakeIbApi()
    const config = loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU12345' })
    const session = new TwsSession(config.ibkr, fake as unknown as IBApi)

    session.connect()
    fake.emit(EventName.connected)
    fake.emit(EventName.managedAccounts, 'DU12345')
    fake.emit(EventName.nextValidId, 100)
    fake.emit(EventName.accountSummaryEnd, fake.accountSummaryRequestId)
    fake.emit(EventName.positionEnd)
    fake.emit(EventName.openOrderEnd)
    fake.emit(EventName.completedOrdersEnd)
    fake.emit(EventName.execDetailsEnd, fake.executionRequestId)

    const readyMessage = session.snapshot().message
    fake.emit(EventName.error, new Error('Requested market data is not subscribed'), 10167, 26955)

    expect(session.snapshot()).toMatchObject({
      state: 'ready',
      message: readyMessage,
      lastErrorCode: 10167,
    })
    session.disconnect()
  })
})
