import { EventEmitter } from 'node:events'
import { EventName, type IBApi } from '@stoqey/ib'
import { expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'

it('preserves the instant when IBKR reports a GTD value in an IANA time zone', () => {
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const ib = Object.assign(new EventEmitter(), {
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    reqIds: vi.fn(),
  })
  new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU123' })),
    store,
    ib as unknown as IBApi,
  )

  ib.emit(
    EventName.openOrder,
    3516,
    {
      symbol: 'AAPL',
      secType: 'OPT',
      exchange: 'SMART',
      currency: 'USD',
      lastTradeDateOrContractMonth: '20260918',
      strike: 325,
      right: 'C',
      multiplier: 100,
    },
    {
      account: 'DU123',
      action: 'BUY',
      orderType: 'LMT',
      tif: 'GTD',
      goodTillDate: '20260912 17:59:00 US/Eastern',
      totalQuantity: 1,
      lmtPrice: 0.01,
    },
    { status: 'PreSubmitted' },
  )

  expect(store.getState().orders[0]).toMatchObject({
    id: '3516',
    duration: 'gtd',
    durationDateTime: Date.UTC(2026, 8, 12, 21, 59, 0),
  })
})
