import type { Contract, Execution as IbExecution, Order as IbOrder, OrderState } from '@stoqey/ib'
import { describe, expect, it } from 'vitest'
import { parseIbBarTime } from '../src/ibkr/market-data.js'
import {
  fromIbExecution,
  fromIbOpenOrder,
  ibkrOrderModificationRejection,
  mapOrderStatus,
  toIbOrder,
} from '../src/ibkr/order-conversion.js'
import type { Order } from '../src/ibkr/types.js'

const stockContract: Contract = {
  symbol: 'AAPL',
  secType: 'STK',
  exchange: 'SMART',
  currency: 'USD',
}

const order: Order = {
  id: '1400',
  brokerOrderId: 1400,
  accountId: 'DU123',
  symbol: { symbol: 'AAPL', exchange: 'SMART', currency: 'USD', assetClass: 'stock' },
  side: 'sell',
  type: 'limit',
  duration: 'day',
  quantity: 5,
  limitPrice: 150,
  status: 'working',
  submittedAt: '2026-09-30T12:00:00Z',
  updatedAt: '2026-09-30T12:00:00Z',
}

function readback(overrides: Partial<IbOrder> = {}, contract = stockContract): Order {
  return fromIbOpenOrder(
    1400,
    contract,
    {
      action: 'SELL',
      orderType: 'LMT',
      tif: 'DAY',
      totalQuantity: 5,
      lmtPrice: 150,
      account: 'DU123',
      ...overrides,
    } as IbOrder,
    { status: 'Submitted' } as OrderState,
  )
}

describe('OCA preview isolation', () => {
  it('strips both normalized and raw OCA fields from an independent what-if', () => {
    const grouped: Order = {
      ...order,
      oca: { groupId: 'pair-42', behavior: 'reduce-with-block' },
      ocaGroup: 'pair-42',
      ocaType: 2,
    }
    const preview = toIbOrder(1401, grouped, true, { whatIf: true })
    expect(preview.whatIf).toBe(true)
    expect(preview).not.toHaveProperty('ocaGroup')
    expect(preview).not.toHaveProperty('ocaType')
    expect(toIbOrder(1400, grouped, true)).toMatchObject({ ocaGroup: 'pair-42', ocaType: 2 })
  })

  it('preserves intentionally raw bracket OCA fields only on the live order', () => {
    const grouped: Order = { ...order, ocaGroup: 'parent-exit-L1', ocaType: 2 }
    expect(toIbOrder(1400, grouped, true)).toMatchObject({ ocaGroup: 'parent-exit-L1', ocaType: 2 })
    expect(toIbOrder(1401, grouped, true, { whatIf: true })).not.toHaveProperty('ocaGroup')
  })
})

describe('pip trailing readback', () => {
  it.each([
    [stockContract, 0.5],
    [{ symbol: 'EUR', secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' }, 0.006],
  ])('retains price-amount trails without guessing a pip distance', (contract, amount) => {
    const restored = readback(
      { orderType: 'TRAIL', auxPrice: amount, trailingPercent: Number.MAX_VALUE },
      contract,
    )
    expect(restored.trailingStopPips).toBeUndefined()
    expect(restored.customFields?.ibkrTrailingAmount).toBe(amount)
    expect(restored.trailPercent).toBeUndefined()
    expect(() => toIbOrder(1400, restored, true)).toThrow(/pip size/i)
  })

  it('retains percent trails without inferring a second amount', () => {
    const restored = readback({
      orderType: 'TRAIL',
      auxPrice: Number.MAX_VALUE,
      trailingPercent: 2,
    })
    expect(restored.trailPercent).toBe(2)
    expect(restored.trailingStopPips).toBeUndefined()
    expect(toIbOrder(1400, restored, true)).not.toHaveProperty('auxPrice')
  })

  it('refuses to transmit both trailing distance methods', () => {
    expect(() =>
      toIbOrder(
        1400,
        { ...order, type: 'trailing-stop', trailPercent: 2, trailingStopPips: 50 },
        true,
      ),
    ).toThrow(/one trailing distance/i)
  })
})

describe('unsupported broker order safety', () => {
  it('retains an Adaptive order priority instead of replacing it with Normal', () => {
    const restored = readback({
      algoStrategy: 'Adaptive',
      algoParams: [{ tag: 'adaptivePriority', value: 'Urgent' }],
    })
    expect(toIbOrder(1400, restored, true).algoParams).toEqual([
      { tag: 'adaptivePriority', value: 'Urgent' },
    ])
  })

  it('preserves a signed relative offset during broker readback', () => {
    const restored = readback({ orderType: 'REL', auxPrice: -0.02 })
    expect(restored.relativeOffset).toBe(-0.02)
    expect(toIbOrder(1400, restored, true).auxPrice).toBe(-0.02)
  })

  it.each(['SSHORT', 'SLONG'])(
    'preserves %s sell designation on supported order readback and writeback',
    (action) => {
      const restored = readback({ action: action as IbOrder['action'] })
      expect(restored.side).toBe('sell')
      expect(restored.customFields?.ibkrAction).toBe(action)
      expect(ibkrOrderModificationRejection(restored)).toBeUndefined()
      expect(toIbOrder(1400, restored, true).action).toBe(action)
    },
  )

  it.each([
    [{ orderType: 'MIT' }, 'order type'],
    [{ orderType: 'LIT' }, 'order type'],
    [{ tif: 'DTC' }, 'time in force'],
    [{ action: 'UNKNOWN' }, 'action'],
    [{ action: 'SSHORTX' }, 'action'],
    [{ algoStrategy: 'Vwap' }, 'algorithm'],
    [{ algoStrategy: 'Adaptive', orderType: 'MKT' }, 'algorithm'],
  ])('refuses lossy broker order retransmission for %j', (overrides, reason) => {
    const restored = readback(overrides as Partial<IbOrder>)
    expect(restored.customFields?.ibkrReadbackUnsupported).toBe(true)
    expect(ibkrOrderModificationRejection(restored)).toContain(reason)
    expect(() => toIbOrder(1400, restored, true)).toThrow(/unsupported/i)
  })

  it('records the authoritative raw broker type, TIF and action', () => {
    const restored = readback({
      orderType: 'MIT',
      tif: 'DTC',
      action: 'SSHORT',
    } as Partial<IbOrder>)
    expect(restored.brokerOrderTypeId).toBe('MIT')
    expect(restored.customFields).toMatchObject({
      ibkrOrderType: 'MIT',
      ibkrTimeInForce: 'DTC',
      ibkrAction: 'SSHORT',
    })
  })

  it('does not silently drop a short-sale designation when changing sides', () => {
    const restored = readback({ action: 'SSHORT' as IbOrder['action'] })
    expect(() => toIbOrder(1400, { ...restored, side: 'buy' }, true)).toThrow(/action/i)
  })
})

describe('execution timestamps', () => {
  function execution(time: string): string {
    return fromIbExecution(stockContract, {
      execId: 'synthetic-fill',
      time,
      orderId: 1400,
      side: 'SLD',
      shares: 1,
      price: 150,
    } as IbExecution).timestamp
  }

  it.each([
    ['20260930  14:30:00 US/Eastern', '2026-09-30T18:30:00.000Z'],
    ['20260130 14:30:00 America/New_York', '2026-01-30T19:30:00.000Z'],
    ['20260930-14:30:00', '2026-09-30T14:30:00.000Z'],
    ['1790778600', '2026-09-30T14:30:00.000Z'],
  ])('parses broker execution time %s', (input, expected) => {
    expect(execution(input)).toBe(expected)
  })

  it('keeps a wall clock unknown when the TWS login zone was not supplied', () => {
    expect(execution('20260930  14:30:00')).toBe('')
    expect(execution('20260930 14:30:00')).toBe('')
  })

  it.each([
    'invalid',
    '20260230 14:30:00 UTC',
    '20260930 24:00:00 UTC',
    '20260930 14:30:00 Unknown/Zone',
    '20260308 02:30:00 America/New_York',
  ])('keeps an unknown broker timestamp unknown for %s', (input) => {
    expect(execution(input)).toBe('')
  })

  it('leaves historical-bar parsing on its established UTC/daily convention', () => {
    expect(parseIbBarTime('20260930')).toBe(Date.UTC(2026, 8, 30))
    expect(parseIbBarTime('20260930 14:30:00')).toBe(Date.UTC(2026, 8, 30, 14, 30))
  })
})

describe('partial fill status', () => {
  it.each([
    'placing',
    'pre-submitted',
    'working',
    'partially-filled',
    'filled',
    'cancelled',
    'rejected',
    'inactive',
  ])('preserves normalized %s bridge status', (status) => {
    expect(mapOrderStatus(status)).toBe(status)
  })

  it.each(['Submitted', 'PreSubmitted', 'PendingCancel', 'Unrecognized'])(
    'keeps partial fills for active %s callbacks',
    (status) => {
      expect(mapOrderStatus(status, 50, 50)).toBe('partially-filled')
    },
  )

  it.each([
    ['Filled', 'filled'],
    ['Cancelled', 'cancelled'],
    ['ApiCancelled', 'cancelled'],
    ['Inactive', 'inactive'],
    ['PendingSubmit', 'placing'],
    ['ApiPending', 'placing'],
  ])('preserves terminal or acknowledgement status %s', (status, expected) => {
    expect(mapOrderStatus(status, 50, 50)).toBe(expected)
  })
})
