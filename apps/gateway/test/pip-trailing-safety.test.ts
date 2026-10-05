import { EventEmitter } from 'node:events'
import type { Contract, IBApi, Order as IbOrder, OrderState } from '@stoqey/ib'
import { EventName } from '@stoqey/ib'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { createBridgeConfig } from '../src/ibkr/config.js'
import { IbkrService } from '../src/ibkr/ibkr-service.js'
import {
  fromIbOpenOrder,
  ibkrOrderModificationRejection,
  toIbOrder,
} from '../src/ibkr/order-conversion.js'
import { validateDraft } from '../src/ibkr/order-validation.js'
import { BrokerStateStore } from '../src/ibkr/state-store.js'
import type { Order, OrderDraft } from '../src/ibkr/types.js'

const instruments = [
  {
    label: 'ES futures',
    symbol: {
      symbol: 'IBKR:101',
      canonicalSymbol: 'IBKR:101',
      assetClass: 'futures',
      exchange: 'CME',
      currency: 'USD',
      priceIncrements: [{ lowEdge: 0, increment: 0.25 }],
    },
    native: { symbol: 'ES', secType: 'FUT', conId: 101, exchange: 'CME', currency: 'USD' },
    amount: 5,
  },
  {
    label: 'JPY forex',
    symbol: {
      symbol: 'USD.JPY',
      assetClass: 'forex',
      exchange: 'IDEALPRO',
      currency: 'JPY',
      priceIncrements: [{ lowEdge: 0, increment: 0.005 }],
    },
    native: { symbol: 'USD', secType: 'CASH', exchange: 'IDEALPRO', currency: 'JPY' },
    amount: 0.2,
  },
] satisfies Array<{ label: string; symbol: OrderDraft['symbol']; native: Contract; amount: number }>

const draftFor = (symbol: OrderDraft['symbol']): OrderDraft => ({
  symbol,
  accountId: 'test-account',
  side: 'sell',
  type: 'trailing-stop',
  duration: 'day',
  quantity: 1,
  trailingStopPips: 20,
})
const asOrder = (draft: OrderDraft): Order => ({
  ...draft,
  id: '100',
  status: 'working',
  submittedAt: '2026-09-30T10:00:00Z',
  updatedAt: '2026-09-30T10:00:00Z',
})

describe.each(instruments)('$label pip distance requires authoritative units', (instrument) => {
  it('refuses to treat a market-rule tick as a market pip when validating or transmitting', () => {
    const draft = draftFor(instrument.symbol)
    expect(validateDraft(draft)).toMatchObject({
      accepted: false,
      reason: expect.stringMatching(/pip size/i),
    })
    expect(() => toIbOrder(100, asOrder(draft), true)).toThrow(/pip size/i)
  })

  it('preserves absolute broker trail amount without fabricating a pip count', () => {
    const restored = fromIbOpenOrder(
      100,
      instrument.native,
      {
        action: 'SELL',
        orderType: 'TRAIL',
        tif: 'DAY',
        totalQuantity: 1,
        auxPrice: instrument.amount,
        trailingPercent: Number.MAX_VALUE,
      } as IbOrder,
      { status: 'Submitted' } as OrderState,
    )
    expect(restored.trailingStopPips).toBeUndefined()
    expect(restored.customFields?.ibkrTrailingAmount).toBe(instrument.amount)
    expect(ibkrOrderModificationRejection(restored)).toMatch(/pip size/i)
    expect(() => toIbOrder(100, restored, true)).toThrow(/pip size/i)
  })

  it('keeps explicit percent trailing valid and emits only the percent distance', () => {
    const draft = { ...draftFor(instrument.symbol), trailingStopPips: undefined, trailPercent: 2 }
    expect(validateDraft(draft).accepted).toBe(true)
    expect(toIbOrder(100, asOrder(draft), true)).toMatchObject({
      orderType: 'TRAIL',
      trailingPercent: 2,
    })
    expect(toIbOrder(100, asOrder(draft), true)).not.toHaveProperty('auxPrice')
    const restored = fromIbOpenOrder(
      100,
      instrument.native,
      {
        action: 'SELL',
        orderType: 'TRAIL',
        tif: 'DAY',
        totalQuantity: 1,
        trailingPercent: 2,
      } as IbOrder,
      { status: 'Submitted' } as OrderState,
    )
    expect(ibkrOrderModificationRejection(restored)).toBeUndefined()
    expect(toIbOrder(100, restored, true)).toMatchObject({ trailingPercent: 2 })
  })

  it.each(['entry', 'protection'] as const)(
    'rejects pip %s before dispatching any broker order',
    async (kind) => {
      const ib = Object.assign(new EventEmitter(), { placeOrder: vi.fn(), reqIds: vi.fn() })
      const store = new BrokerStateStore()
      store.setConnectionStatus('connected')
      const service = new IbkrService(
        createBridgeConfig(loadGatewayConfig({ IBKR_ALLOWED_ACCOUNT_IDS: 'test-account' })),
        store,
        ib as unknown as IBApi,
      )
      ib.emit(EventName.nextValidId, 100)
      // biome-ignore lint/complexity/useLiteralKeys: Private mock seam proves validation before broker dispatch.
      vi.spyOn(service['requests'], 'requestContractDetails').mockResolvedValue([
        { contract: instrument.native },
      ])
      // biome-ignore lint/complexity/useLiteralKeys: Keep broker previews deterministic without replacing draft validation.
      vi.spyOn(service['orders'].previews, 'previewOrderWithIbkrWhatIf').mockResolvedValue({
        accepted: true,
      })
      // biome-ignore lint/complexity/useLiteralKeys: Keep bracket previews deterministic without replacing draft validation.
      vi.spyOn(service['orders'].previews, 'previewBracketWithIbkrWhatIf').mockResolvedValue({
        accepted: true,
      })
      const draft =
        kind === 'entry'
          ? draftFor(instrument.symbol)
          : {
              ...draftFor(instrument.symbol),
              type: 'market' as const,
              trailingStopPips: undefined,
              exits: {
                levels: [
                  {
                    id: 'protected',
                    quantity: 1,
                    stopLoss: { kind: 'trailing' as const, trailingPips: 20 },
                  },
                ],
              },
            }
      await expect(service.placeOrder(draft)).rejects.toThrow(/pip size/i)
      expect(ib.placeOrder).not.toHaveBeenCalled()
      expect(store.getState().orders).toEqual([])
    },
  )
})
