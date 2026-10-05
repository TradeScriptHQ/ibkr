import type { Contract, Execution as IbExecution, Order as IbOrder, OrderState } from '@stoqey/ib'
import { OrderType as IbOrderType, OrderAction, TimeInForce } from '@stoqey/ib'
import {
  fromIbOptionContract,
  fromIbOptionLegs,
  fromIbSymbol,
  normalizeRoutingDestination,
} from './contracts.js'
import { positiveContractId, positiveNumber } from './numbers.js'
import { authoritativePipDefinition, pipDistanceInPrice } from './pip-definitions.js'
import type {
  Execution,
  Order,
  OrderDraft,
  OrderDuration,
  OrderStatus,
  OrderType,
  Position,
} from './types.js'

export type IbOrderOverrideOptions = {
  overridePercentageConstraints?: boolean | undefined
  advancedErrorOverride?: string | undefined
  whatIf?: boolean | undefined
}

type IbOrderWithOverrides = {
  [K in keyof IbOrder]: IbOrder[K] | undefined
} & IbOrderOverrideOptions

export function toIbOrder(
  orderId: number,
  order: Order,
  transmit: boolean,
  options: IbOrderOverrideOptions = {},
): IbOrder {
  const unsupported = ibkrOrderModificationRejection(order)
  if (unsupported) throw new Error(unsupported)
  if (
    order.type === 'trailing-stop' &&
    order.trailPercent != null &&
    order.trailingStopPips != null
  ) {
    throw new Error('A trailing stop requires exactly one trailing distance method.')
  }
  if (
    order.type === 'trailing-stop' &&
    order.trailingStopPips != null &&
    pipDistanceInPrice(order.symbol, order.trailingStopPips) === undefined
  ) {
    throw new Error(
      'Pip-based trailing stops are unavailable: the authoritative instrument pip size is not supplied. Use trailing percent or TWS.',
    )
  }
  const oca = order.oca ? toIbOca(order.oca) : undefined
  const ibOrder: IbOrderWithOverrides = {
    orderId,
    action: toIbAction(order),
    orderType: toIbOrderType(order.type),
    totalQuantity: order.cashQuantity === undefined ? order.quantity : undefined,
    cashQty: order.cashQuantity,
    lmtPrice: order.limitPrice,
    auxPrice: order.stopPrice,
    tif: toIbDuration(order.duration),
    goodTillDate: order.duration === 'gtd' ? toIbGoodTillDate(order.durationDateTime) : undefined,
    includeOvernight:
      order.duration === 'overnight' || order.duration === 'overnight-day' || undefined,
    account: order.accountId,
    orderRef: options.whatIf ? undefined : order.brokerOrderRef,
    transmit,
    outsideRth: order.outsideRth || undefined,
    hidden: order.hidden || undefined,
    displaySize: order.displaySize,
    allOrNone: order.allOrNone,
    ocaGroup: options.whatIf ? undefined : (oca?.ocaGroup ?? order.ocaGroup),
    ocaType: options.whatIf ? undefined : (oca?.ocaType ?? order.ocaType),
    whatIf: options.whatIf || undefined,
  }
  if (order.type === 'trailing-stop') {
    ibOrder.lmtPrice = undefined
    ibOrder.auxPrice =
      order.trailingStopPips === undefined
        ? undefined
        : pipDistanceInPrice(order.symbol, order.trailingStopPips)
    ibOrder.trailStopPrice = order.stopPrice
    ibOrder.trailingPercent = order.trailPercent
  } else if (order.type === 'trailing-stop-limit') {
    ibOrder.lmtPrice = undefined
    ibOrder.auxPrice = undefined
    ibOrder.trailStopPrice = order.stopPrice
    ibOrder.trailingPercent = order.trailPercent
    ibOrder.lmtPriceOffset = order.limitPrice
  } else if (order.type === 'relative' || order.type === 'retail-price-improvement') {
    ibOrder.auxPrice = order.relativeOffset
  }
  if (order.postOnly) {
    ibOrder.postToAts = 1
  }
  if (order.type === 'adaptive' || order.type === 'ib-algo') {
    ibOrder.algoStrategy = 'Adaptive'
    const rawParameters = order.customFields?.ibkrAlgoParams
    const restoredParameters = Array.isArray(rawParameters)
      ? rawParameters.filter(
          (parameter): parameter is { tag: string; value: string } =>
            typeof parameter === 'object' &&
            parameter !== null &&
            typeof parameter.tag === 'string' &&
            typeof parameter.value === 'string',
        )
      : undefined
    ibOrder.algoParams = restoredParameters?.length
      ? restoredParameters
      : [{ tag: 'adaptivePriority', value: 'Normal' }]
  }
  const parentId = Number(order.parentId)
  if (Number.isFinite(parentId) && parentId > 0) {
    ibOrder.parentId = parentId
  }
  if (options.overridePercentageConstraints) {
    ibOrder.overridePercentageConstraints = true
  }
  if (options.advancedErrorOverride) {
    ibOrder.advancedErrorOverride = options.advancedErrorOverride
  }
  // TWS optional fields must be absent, not explicitly undefined.
  return {
    ...Object.fromEntries(Object.entries(ibOrder).filter(([, value]) => value !== undefined)),
    orderType: toIbOrderType(order.type),
  }
}

/** Broker callbacks with unsupported wire semantics may be inspected/cancelled, never rewritten. */
export function ibkrOrderModificationRejection(order: Order): string | undefined {
  const reasons = order.customFields?.ibkrReadbackUnsupportedReasons
  if (order.customFields?.ibkrReadbackUnsupported === true) {
    const details = Array.isArray(reasons)
      ? reasons.filter((reason): reason is string => typeof reason === 'string').join('; ')
      : 'unmapped broker fields'
    return `Unsupported IBKR order cannot be modified: ${details}. Use TWS to modify it.`
  }
  const action = order.customFields?.ibkrAction
  if ((action === 'SSHORT' || action === 'SLONG') && order.side !== 'sell') {
    return `Unsupported action change would discard the broker's ${action} designation.`
  }
  return undefined
}

function toIbAction(order: Order): OrderAction {
  const action = order.customFields?.ibkrAction
  if (action === 'SSHORT') return OrderAction.SSHORT
  if (action === 'SLONG') return OrderAction.SLONG
  return order.side === 'buy' ? OrderAction.BUY : OrderAction.SELL
}

function toIbOca(oca: NonNullable<OrderDraft['oca']>): {
  ocaGroup: string
  ocaType: number
} {
  const groupId = oca.groupId.trim()
  const ocaType =
    oca.behavior === 'cancel-with-block' ? 1 : oca.behavior === 'reduce-with-block' ? 2 : 3
  return { ocaGroup: groupId, ocaType }
}

function fromIbOca(
  groupId: string | undefined,
  value: number | undefined,
): OrderDraft['oca'] | undefined {
  const normalizedGroupId = groupId?.trim()
  if (!normalizedGroupId) return undefined
  const behavior =
    value === 1
      ? 'cancel-with-block'
      : value === 2
        ? 'reduce-with-block'
        : value === 3
          ? 'reduce-without-block'
          : undefined
  return behavior ? { groupId: normalizedGroupId, behavior } : undefined
}

function toIbOrderType(type: OrderType): IbOrderType {
  switch (type) {
    case 'market':
      return IbOrderType.MKT
    case 'limit':
      return IbOrderType.LMT
    case 'midprice':
      return IbOrderType.MIDPRICE
    case 'market-to-limit':
      return IbOrderType.MTL
    case 'stop':
      return IbOrderType.STP
    case 'stop-limit':
      return IbOrderType.STP_LMT
    case 'trailing-stop':
      return IbOrderType.TRAIL
    case 'trailing-stop-limit':
      return IbOrderType.TRAIL_LIMIT
    case 'relative':
      return IbOrderType.REL
    case 'retail-price-improvement':
      return IbOrderType.PASSV_REL
    case 'peg-mid':
      return IbOrderType.PEG_MID
    case 'peg-best':
      return IbOrderType.PEG_BEST
    case 'snap-market':
      return IbOrderType.SNAP_MKT
    case 'snap-mid':
      return IbOrderType.SNAP_MID
    case 'snap-primary':
      return IbOrderType.SNAP_PRIM
    case 'market-on-close':
      return IbOrderType.MOC
    case 'limit-on-close':
      return IbOrderType.LOC
    case 'adaptive':
      return IbOrderType.LMT
    case 'ib-algo':
      return IbOrderType.LMT
  }
}

function toIbDuration(duration: OrderDuration): TimeInForce {
  if (duration === 'gtc') return TimeInForce.GTC
  if (duration === 'gtd') return TimeInForce.GTD
  if (duration === 'ioc') return TimeInForce.IOC
  if (duration === 'fok') return TimeInForce.FOK
  if (duration === 'opg') return TimeInForce.OPG
  return TimeInForce.DAY
}

function toIbGoodTillDate(datetime: number | undefined): string | undefined {
  if (!Number.isFinite(datetime)) return undefined
  const value = new Date(Number(datetime))
  const yyyy = String(value.getUTCFullYear()).padStart(4, '0')
  const mm = String(value.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(value.getUTCDate()).padStart(2, '0')
  const hh = String(value.getUTCHours()).padStart(2, '0')
  const min = String(value.getUTCMinutes()).padStart(2, '0')
  const ss = String(value.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd} ${hh}:${min}:${ss} UTC`
}

export function fromIbOpenOrder(
  orderId: number,
  contract: Contract,
  order: IbOrder,
  orderState: OrderState,
): Order {
  const timestamp = new Date().toISOString()
  const rawType = String(order.orderType ?? '')
    .trim()
    .toUpperCase()
  const rawAction = String(order.action ?? '')
    .trim()
    .toUpperCase()
  const rawTif = String(order.tif ?? '')
    .trim()
    .toUpperCase()
  const rawAlgorithm = String(order.algoStrategy ?? '').trim()
  const mappedType = fromIbOrderType(rawType)
  const mappedDuration = fromIbDuration(order, contract)
  const unsupportedReasons: string[] = []
  if (mappedType === undefined) unsupportedReasons.push(`order type ${rawType || '(missing)'}`)
  if (!['BUY', 'SELL', 'SSHORT', 'SLONG'].includes(rawAction)) {
    unsupportedReasons.push(`action ${rawAction || '(missing)'}`)
  }
  if (mappedDuration === undefined)
    unsupportedReasons.push(`time in force ${rawTif || '(missing)'}`)
  if (rawAlgorithm && (rawAlgorithm.toLowerCase() !== 'adaptive' || rawType !== 'LMT')) {
    unsupportedReasons.push(`algorithm ${rawAlgorithm} with ${rawType}`)
  }
  // These legacy shape defaults are explicitly flagged and cannot be retransmitted.
  // The SDK has no unsupported order/type/side representation; raw values remain authoritative.
  const type =
    rawAlgorithm.toLowerCase() === 'adaptive' && rawType === 'LMT'
      ? 'adaptive'
      : (mappedType ?? 'limit')
  const parentId = Number(order.parentId)
  const optionLegs = fromIbOptionLegs(contract, order)
  const auxPrice = fromIbPrice(order.auxPrice)
  const trailStopPrice = fromIbPrice(order.trailStopPrice)
  const trailPercent = fromIbPrice(order.trailingPercent)
  const symbol = fromIbSymbol(contract)
  const definition = authoritativePipDefinition(symbol)
  if (definition) symbol.pipDefinition = definition
  const absoluteTrail =
    type === 'trailing-stop' && trailPercent === undefined ? auxPrice : undefined
  const pipDefinition = authoritativePipDefinition(symbol)
  if (absoluteTrail !== undefined && !pipDefinition) {
    unsupportedReasons.push('absolute trailing amount has no authoritative instrument pip size')
  }
  const ocaType = Number(order.ocaType) || undefined
  const displaySizeValue = Number(order.displaySize)
  const displaySize =
    Number.isFinite(displaySizeValue) && displaySizeValue > 0 ? displaySizeValue : undefined
  return {
    id: String(orderId),
    brokerOrderId: orderId,
    brokerOrderRef:
      typeof order.orderRef === 'string' && order.orderRef ? order.orderRef : undefined,
    permId: positiveContractId(order.permId),
    clientId:
      Number.isInteger(order.clientId) && Number(order.clientId) >= 0
        ? Number(order.clientId)
        : undefined,
    accountId: String(order.account ?? ''),
    symbol,
    side: ['SELL', 'SSHORT', 'SLONG', 'SSHORTX'].includes(rawAction) ? 'sell' : 'buy',
    type,
    brokerOrderTypeId: rawType || undefined,
    duration: mappedDuration ?? 'day',
    durationDateTime: fromIbGoodTillDate(order.goodTillDate),
    quantity: Number(order.totalQuantity ?? 0),
    cashQuantity: positiveNumber(order.cashQty),
    limitPrice:
      type === 'trailing-stop-limit'
        ? Number(order.lmtPriceOffset) || undefined
        : Number(order.lmtPrice) || undefined,
    stopPrice:
      type === 'trailing-stop' || type === 'trailing-stop-limit' ? trailStopPrice : auxPrice,
    trailPercent,
    trailingStopPips:
      absoluteTrail !== undefined && pipDefinition
        ? absoluteTrail / pipDefinition.pipSize
        : undefined,
    relativeOffset:
      type === 'relative' || type === 'retail-price-improvement' ? auxPrice : undefined,
    postOnly: Number(order.postToAts) > 0 || undefined,
    routingDestination: normalizeRoutingDestination(String(contract.exchange ?? '')),
    allOrNone: order.allOrNone,
    oca: fromIbOca(order.ocaGroup, ocaType),
    outsideRth: order.outsideRth || undefined,
    hidden: order.hidden || undefined,
    displaySize,
    ocaGroup: order.ocaGroup,
    ocaType,
    status: mapOrderStatus(String(orderState.status ?? 'working')),
    submittedAt: timestamp,
    updatedAt: timestamp,
    parentId: Number.isFinite(parentId) && parentId > 0 ? String(parentId) : undefined,
    parentType: Number.isFinite(parentId) && parentId > 0 ? 'order' : undefined,
    bracketGroupId: Number.isFinite(parentId) && parentId > 0 ? String(parentId) : undefined,
    optionLegs: optionLegs.length ? optionLegs : undefined,
    customFields: {
      orderVisibility: displaySize ? 'iceberg' : order.hidden ? 'hidden' : 'visible',
      displaySize,
      ibkrOrderType: rawType,
      ibkrAction: rawAction,
      ibkrTimeInForce: rawTif,
      ibkrAlgoStrategy: rawAlgorithm,
      ibkrTrailingAmount: absoluteTrail,
      ibkrAlgoParams: order.algoParams?.map(({ tag, value }) => ({ tag, value })),
      ibkrReadbackUnsupported: unsupportedReasons.length > 0,
      ibkrReadbackUnsupportedReasons: unsupportedReasons,
    },
    message: orderState.warningText,
  }
}

function fromIbDuration(order: IbOrder, contract: Contract): OrderDuration | undefined {
  const tif = String(order.tif ?? '').toUpperCase()
  if (order.includeOvernight) {
    if (tif !== 'DAY') return undefined
    return String(contract.exchange).toUpperCase() === 'OVERNIGHT' ? 'overnight' : 'overnight-day'
  }
  if (tif === 'DAY') return 'day'
  if (tif === 'GTC') return 'gtc'
  if (tif === 'GTD') return 'gtd'
  if (tif === 'IOC') return 'ioc'
  if (tif === 'FOK') return 'fok'
  if (tif === 'OPG') return 'opg'
  return undefined
}

function fromIbPrice(value: number | undefined): number | undefined {
  // TWS represents unset prices/percentages with its maximum-double sentinel.
  return value !== undefined && Number.isFinite(value) && value !== 0 && Math.abs(value) < 1e100
    ? value
    : undefined
}

function fromIbGoodTillDate(value: string | undefined): number | undefined {
  if (!value) return undefined
  return parseIbWallClock(value)
}

/** TWS wall clocks need their login zone; the gateway host zone is not broker evidence. */
export function parseIbExecutionTime(value: string): number | undefined {
  const normalized = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const timestamp = Number(normalized) * 1000
    return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : undefined
  }
  if (/^\d{8}-\d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return parseIbWallClock(`${normalized.replace('-', ' ')} UTC`)
  }
  if (/^\d{8}\s+\d{2}:\d{2}:\d{2}$/.test(normalized)) return undefined
  return parseIbWallClock(normalized)
}

function parseIbWallClock(value: string): number | undefined {
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+([A-Za-z0-9/_+-]+))?$/,
  )
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, zone] = match
  const wallClockTimestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  const wallClockDate = new Date(wallClockTimestamp)
  if (
    wallClockDate.getUTCFullYear() !== Number(year) ||
    wallClockDate.getUTCMonth() !== Number(month) - 1 ||
    wallClockDate.getUTCDate() !== Number(day) ||
    wallClockDate.getUTCHours() !== Number(hour) ||
    wallClockDate.getUTCMinutes() !== Number(minute) ||
    wallClockDate.getUTCSeconds() !== Number(second)
  )
    return undefined
  if (!zone) {
    const timestamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}`)
    const local = new Date(timestamp)
    return Number.isFinite(timestamp) &&
      local.getFullYear() === Number(year) &&
      local.getMonth() === Number(month) - 1 &&
      local.getDate() === Number(day) &&
      local.getHours() === Number(hour) &&
      local.getMinutes() === Number(minute) &&
      local.getSeconds() === Number(second)
      ? timestamp
      : undefined
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    let timestamp = wallClockTimestamp
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(timestamp))
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, Number(part.value)]),
      )
      const renderedWallClock = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      )
      if (renderedWallClock === wallClockTimestamp) return timestamp
      timestamp += wallClockTimestamp - renderedWallClock
    }
    return undefined
  } catch {
    return undefined
  }
}

function fromIbOrderType(type: string): OrderType | undefined {
  const normalized = type.toUpperCase()
  if (normalized === 'MKT') return 'market'
  if (normalized === 'LMT') return 'limit'
  if (normalized === 'MIDPRICE') return 'midprice'
  if (normalized === 'MTL') return 'market-to-limit'
  if (normalized === 'STP') return 'stop'
  if (normalized === 'STP LMT' || normalized === 'STP_LMT') return 'stop-limit'
  if (normalized === 'TRAIL') return 'trailing-stop'
  if (normalized === 'TRAIL LIMIT') return 'trailing-stop-limit'
  if (normalized === 'REL') return 'relative'
  if (normalized === 'PASSV REL') return 'retail-price-improvement'
  if (normalized === 'PEG MID' || normalized === 'PEGMID') return 'peg-mid'
  if (normalized === 'PEG BEST' || normalized === 'PEGBEST') return 'peg-best'
  if (normalized === 'SNAP MKT') return 'snap-market'
  if (normalized === 'SNAP MID') return 'snap-mid'
  if (normalized === 'SNAP PRIM') return 'snap-primary'
  if (normalized === 'MOC') return 'market-on-close'
  if (normalized === 'LOC') return 'limit-on-close'
  return undefined
}

export function fromIbPosition(
  accountId: string,
  contract: Contract,
  quantity: number,
  avgCost: number,
): Position {
  const symbol = fromIbSymbol(contract)
  const definition = authoritativePipDefinition(symbol)
  if (definition) symbol.pipDefinition = definition
  const derivative = ['FUT', 'FOP', 'OPT'].includes(String(contract.secType))
  const multiplier = positiveNumber(contract.multiplier)
  const averagePrice = derivative
    ? multiplier === undefined
      ? undefined
      : avgCost / multiplier
    : avgCost
  return {
    id: ibkrPositionId(accountId, contract),
    accountId,
    symbol,
    optionContract: fromIbOptionContract(contract),
    quantity,
    avgCost,
    averagePrice,
  }
}

export function fromIbExecution(
  contract: Contract,
  execution: IbExecution,
  accountId?: string,
): Execution {
  const executionTime =
    typeof execution.time === 'string' ? parseIbExecutionTime(execution.time) : undefined
  return {
    id: String(execution.execId ?? `${execution.orderId}-${execution.time}`),
    orderId: execution.orderId != null ? String(execution.orderId) : undefined,
    brokerOrderId: execution.orderId,
    clientId: execution.clientId,
    permId: positiveContractId(execution.permId),
    brokerOrderRef: execution.orderRef,
    cumulativeQuantity:
      Number.isFinite(execution.cumQty) && Number(execution.cumQty) >= 0
        ? Number(execution.cumQty)
        : undefined,
    accountId,
    positionId: accountId ? ibkrPositionId(accountId, contract) : undefined,
    symbol: fromIbSymbol(contract),
    optionContract: fromIbOptionContract(contract),
    side: String(execution.side).toUpperCase().includes('BOT') ? 'buy' : 'sell',
    quantity: Number(execution.shares ?? 0),
    price: Number(execution.price ?? 0),
    // Empty means unknown. Replayed fills must never acquire the reconnect time.
    timestamp: executionTime === undefined ? '' : new Date(executionTime).toISOString(),
  }
}

function ibkrPositionId(accountId: string, contract: Contract): string {
  const contractId = positiveContractId(contract.conId)
  const contractIdentity =
    contractId === undefined
      ? JSON.stringify([
          String(contract.secType ?? ''),
          String(contract.localSymbol ?? contract.symbol ?? ''),
          String(contract.exchange ?? 'SMART'),
          String(contract.primaryExch ?? ''),
          String(contract.currency ?? ''),
          String(contract.lastTradeDateOrContractMonth ?? contract.lastTradeDate ?? ''),
          Number(contract.strike ?? 0),
          String(contract.right ?? ''),
          String(contract.multiplier ?? ''),
        ])
      : String(contractId)
  return `${accountId}:${contractIdentity}`
}

export function mapOrderStatus(status: string, filled?: number, remaining?: number): OrderStatus {
  const normalized = status.toLowerCase().replaceAll('-', '')
  if (normalized === 'partiallyfilled') return 'partially-filled'
  if (normalized === 'placing') return 'placing'
  if (
    ![
      'filled',
      'cancelled',
      'apicancelled',
      'inactive',
      'rejected',
      'pendingsubmit',
      'apipending',
    ].includes(normalized) &&
    Number(filled) > 0 &&
    Number(remaining) > 0
  )
    return 'partially-filled'
  if (normalized === 'presubmitted') return 'pre-submitted'
  if (normalized === 'pendingsubmit' || normalized === 'apipending') return 'placing'
  if (normalized === 'submitted') return 'working'
  if (normalized === 'filled') return 'filled'
  if (normalized === 'cancelled' || normalized === 'apicancelled') return 'cancelled'
  if (normalized === 'inactive') return 'inactive'
  if (normalized === 'rejected') return 'rejected'
  if (normalized === 'pendingcancel') return 'working'
  return 'working'
}
