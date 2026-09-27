import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { describe, expect, it } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { TwsSession } from '../src/tws/tws-session.js'

class FakeIbApi extends EventEmitter {
  isConnected = false
  readonly calls: string[] = []

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

  reqAccountSummary() {
    this.calls.push('reqAccountSummary')
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

  reqExecutions() {
    this.calls.push('reqExecutions')
    return this
  }

  reqIds() {
    this.calls.push('reqIds')
    return this
  }
}

describe('TWS session state machine', () => {
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

    fake.emit(EventName.accountSummaryEnd, 900_001)
    fake.emit(EventName.positionEnd)
    fake.emit(EventName.openOrder, 500, {}, { clientId: 0 }, {})
    fake.emit(EventName.openOrderEnd)
    fake.emit(EventName.completedOrdersEnd)
    fake.emit(EventName.execDetailsEnd, 900_002)

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
    fake.emit(EventName.accountSummaryEnd, 900_001)
    fake.emit(EventName.positionEnd)
    fake.emit(EventName.openOrderEnd)
    fake.emit(EventName.completedOrdersEnd)
    fake.emit(EventName.execDetailsEnd, 900_002)

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
