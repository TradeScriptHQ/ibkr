import { EventEmitter } from 'node:events'
import { type ContractDetails, EventName, type IBApi, type Order as IbOrder } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { OrderDraft } from '../src/ibkr/types.js'

function fixture() {
  const store = new BrokerStateStore()
  store.setConnectionStatus('connected')
  const ib = Object.assign(new EventEmitter(), {
    placeOrder: vi.fn(),
    reqIds: vi.fn(),
    reqMktData: vi.fn(),
    cancelMktData: vi.fn(),
  })
  const service = new IbkrService(
    createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'DU123' })),
    store,
    ib as unknown as IBApi,
  )
  return { service, store, ib }
}

const draft: OrderDraft = {
  accountId: 'DU123',
  symbol: {
    symbol: 'AAPL',
    exchange: 'SMART',
    primaryExchange: 'NASDAQ',
    currency: 'USD',
    assetClass: 'stock',
  },
  side: 'buy',
  type: 'limit',
  duration: 'day',
  quantity: 10,
  limitPrice: 100,
  routingDestination: 'ISLAND',
  allOrNone: true,
  oca: { groupId: 'pair-42', behavior: 'reduce-with-block' },
}

describe('IBKR advanced order control transport', () => {
  it('derives provider controls from the qualified IBKR contract', async () => {
    const { service } = fixture()
    const boundary = service as unknown as {
      requestContractDetails: () => Promise<ContractDetails[]>
    }
    vi.spyOn(boundary, 'requestContractDetails').mockResolvedValue([
      {
        contract: {
          conId: 265598,
          symbol: 'AAPL',
          secType: 'STK',
          exchange: 'SMART',
          primaryExch: 'NASDAQ',
          currency: 'USD',
        },
        validExchanges: 'SMART,ISLAND,OVERNIGHT,SMART',
        orderTypes: 'MKT,LMT,DAY,GTC',
        timeZoneId: 'US/Eastern',
      } as ContractDetails,
    ])

    const session = await service.resolveSession({
      symbol: 'AAPL',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      currency: 'USD',
      assetClass: 'stock',
    })

    expect(session.metadata).toMatchObject({
      routingDestinations: [
        { value: 'SMART', label: 'SMART' },
        { value: 'ISLAND', label: 'ISLAND' },
      ],
      defaultRoutingDestination: 'SMART',
      allOrNone: { supported: true, default: false, supportedOrderTypes: ['limit'] },
      oca: {
        behaviors: [
          { value: 'cancel-with-block' },
          { value: 'reduce-with-block' },
          { value: 'reduce-without-block' },
        ],
      },
    })
    expect(session.metadata?.oca?.defaultBehavior).toBeUndefined()
  })

  it('maps destination, All-or-None and OCA to the TWS contract and order', async () => {
    const { service, store, ib } = fixture()
    vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({
      accepted: true,
      source: 'local',
      confirmId: 'advanced-controls',
    })
    ib.emit(EventName.nextValidId, 1400)

    await service.placeOrder(draft)

    expect(ib.placeOrder).toHaveBeenCalledOnce()
    expect(ib.placeOrder.mock.calls[0]?.[1]).toMatchObject({
      symbol: 'AAPL',
      exchange: 'ISLAND',
      primaryExch: 'NASDAQ',
    })
    expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({
      allOrNone: true,
      ocaGroup: 'pair-42',
      ocaType: 2,
    })

    ib.emit(
      EventName.openOrder,
      1400,
      ib.placeOrder.mock.calls[0]?.[1],
      ib.placeOrder.mock.calls[0]?.[2],
      { status: 'Submitted' },
    )
    expect(store.getState().orders[0]).toMatchObject({
      symbol: { exchange: 'SMART', primaryExchange: 'NASDAQ' },
      routingDestination: 'ISLAND',
    })
  })

  it('restores the advanced fields from the authoritative TWS open-order callback', () => {
    const { store, ib } = fixture()
    ib.emit(
      EventName.openOrder,
      1401,
      {
        symbol: 'AAPL',
        secType: 'STK',
        exchange: 'ISLAND',
        primaryExch: 'NASDAQ',
        currency: 'USD',
      },
      {
        action: 'BUY',
        orderType: 'LMT',
        totalQuantity: 10,
        lmtPrice: 100,
        tif: 'DAY',
        account: 'DU123',
        allOrNone: true,
        ocaGroup: 'pair-42',
        ocaType: 3,
      } as IbOrder,
      { status: 'Submitted' },
    )

    expect(store.getState().orders[0]).toMatchObject({
      routingDestination: 'ISLAND',
      allOrNone: true,
      oca: { groupId: 'pair-42', behavior: 'reduce-without-block' },
    })
  })

  it('removes a general OCA group through the modification contract', async () => {
    const { service, store, ib } = fixture()
    store.upsertOrder({
      ...draft,
      id: '1402',
      brokerOrderId: 1402,
      status: 'working',
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    vi.spyOn(service['orders'], 'previewOrder').mockResolvedValue({
      accepted: true,
      source: 'local',
      confirmId: 'remove-oca',
    })

    const result = await service.modifyOrder('1402', {
      routingDestination: 'SMART',
      allOrNone: false,
      oca: null,
    })

    expect(result.order.oca).toBeUndefined()
    expect(ib.placeOrder.mock.calls[0]?.[2].ocaGroup).toBeUndefined()
    expect(ib.placeOrder.mock.calls[0]?.[2].ocaType).toBeUndefined()
    expect(result.order).toMatchObject({ routingDestination: 'SMART', allOrNone: false })
    expect(ib.placeOrder.mock.calls[0]?.[1]).toMatchObject({ exchange: 'SMART' })
    expect(ib.placeOrder.mock.calls[0]?.[2]).toMatchObject({
      allOrNone: false,
    })
  })

  it('rejects incomplete or unsupported OCA data before contacting TWS', async () => {
    const { service, ib } = fixture()

    await expect(
      service.previewOrder({ ...draft, oca: { groupId: '', behavior: 'cancel-with-block' } }),
    ).resolves.toMatchObject({ accepted: false, reason: expect.stringContaining('non-empty') })
    await expect(
      service.previewOrder({
        ...draft,
        oca: { groupId: 'pair-42', behavior: 'unknown' as 'cancel-with-block' },
      }),
    ).resolves.toMatchObject({ accepted: false, reason: expect.stringContaining('Unsupported') })
    expect(ib.placeOrder).not.toHaveBeenCalled()
  })
})
