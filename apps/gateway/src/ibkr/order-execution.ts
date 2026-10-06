import type {
  ComboLeg,
  Contract,
  Execution as IbExecution,
  Order as IbOrder,
  OrderState,
} from '@stoqey/ib'
import {
  type ErrorCode,
  EventName,
  type IBApi,
  isNonFatalError,
  OrderAction,
  SecType,
} from '@stoqey/ib'
import { OrderIdAllocator } from '../tws/order-id-allocator.js'
import {
  isIbOrderCancellation,
  isIbOrderWarning,
  isOrderPreviewUnavailableError,
  normalizeIbkrMessage,
  parseIbkrPriceControlRejection,
} from './broker-errors.js'
import type { BridgeConfig } from './config.js'
import {
  applyOrderRoutingDestination,
  brokerContractSourceRouteKey,
  fromIbSymbol,
  nativeContractId,
  sourceSymbolIdentityKey,
  toIbContract,
  toIbOptionContract,
} from './contracts.js'
import { opposingForecastContract } from './forecast-contracts.js'
import type { IbkrRequests } from './ibkr-requests.js'
import { nativeMonetaryUnits } from './monetary-units.js'
import { positiveContractId, positiveNumber } from './numbers.js'
import { optionContractWithSourceIdentity, selectExactOptionDetails } from './option-chain.js'
import { OrderPreviews } from './order-previews.js'
import {
  authoritativePriceIncrements,
  orderHasPricedFields,
  orderPriceIncrementRejection,
  selectedMarketRuleId,
} from './order-price-increments.js'
import type { IbOrderOverrideOptions } from './orders.js'
import {
  applyOrderPatch,
  describeOptionLeg,
  exitChildDrafts,
  fromIbExecution,
  fromIbOpenOrder,
  hasOptionLegs,
  hasStrategyLegs,
  ibkrOrderModificationRejection,
  mapOrderStatus,
  parseIbExecutionTime,
  strategyLegsForDraft,
  strategyOrderQuantity,
  toExitChildOrder,
  toIbOrder,
  validateDraft,
} from './orders.js'
import {
  PAPER_OWNER_FIELD,
  type PaperOwnershipJournal,
  paperOwnershipId,
} from './paper-ownership-journal.js'
import { RequestError } from './request-error.js'
import type { BrokerStateStore } from './state-store.js'
import type {
  BrokerContext,
  BrokerSymbol,
  MarketQuote,
  OptionOrderLegDraft,
  Order,
  OrderDraft,
  OrderPatch,
  OrderPreviewResult,
  PaperOwnershipRecovery,
  PlaceOrderResult,
  PositionCloseOptions,
  SourceSymbolIdentity,
  StrategyOrderLegDraft,
} from './types.js'

const ORDER_CANCELLATION_REASON_WAIT_MS = 250
/** Owns order submission, broker acknowledgement and execution reconciliation. */
export class OrderExecution {
  private readonly pendingModifications = new Map<number, Order>()
  private readonly snapshotOrders = new Set<string>()
  private readonly ownershipReplays = new Map<string, Promise<PaperOwnershipRecovery>>()
  private reconciliationVersion = 0
  readonly previews: OrderPreviews
  constructor(
    private readonly ib: IBApi,
    private readonly config: BridgeConfig,
    private readonly store: BrokerStateStore,
    private readonly requests: Pick<IbkrRequests, 'requestContractDetails'> &
      Partial<Pick<IbkrRequests, 'requestMarketRule'>>,
    private readonly quoteForSymbol?: (symbol: BrokerSymbol) => MarketQuote | undefined,
    private readonly orderIds = new OrderIdAllocator(),
    private readonly ownership?: PaperOwnershipJournal,
  ) {
    this.previews = new OrderPreviews(this.ib, this.store, () => this.allocateOrderId())
    if (ownership) {
      const restored = ownership.restored()
      for (const order of restored.orders) this.store.upsertOrder(order)
      for (const execution of restored.executions) this.store.upsertExecution(execution)
      this.store.subscribe((event) => {
        if (event.type !== 'orders' && event.type !== 'orders-history') return
        for (const order of event.orders) {
          try {
            ownership.recordOrder(order)
          } catch {
            this.unknownOwnedReadback(order)
          }
        }
      })
    }
    this.registerHandlers()
  }
  private registerHandlers(): void {
    this.ib.on(EventName.connected, () => {
      this.snapshotOrders.clear()
      this.reconciliationVersion++
      this.ownership?.beginReconciliation()
    })
    this.ib.on(EventName.disconnected, () => {
      this.reconciliationVersion++
      this.ownership?.beginReconciliation()
    })
    this.ib.on(EventName.orderBound, (permId: number, clientId: number, orderId: number) => {
      const existing = this.findBrokerOrder(undefined, permId)
      if (
        !existing ||
        clientId !== this.config.ibkrClientId ||
        !Number.isInteger(orderId) ||
        orderId === 0
      )
        return
      this.orderIds.observeUsed(orderId)
      this.store.upsertOrder({ ...existing, permId, clientId, brokerOrderId: orderId })
    })
    this.ib.on(EventName.nextValidId, (orderId: number) => {
      this.orderIds.observeNextValid(orderId)
    })
    this.ib.on(
      EventName.openOrder,
      (orderId: number, contract: Contract, order: IbOrder, orderState: OrderState) => {
        this.orderIds.observeUsed(orderId)
        if (
          this.previews.resolveWhatIfPreview(orderId, orderState) ||
          this.previews.whatIfOrderIds.has(orderId) ||
          order.whatIf === true
        ) {
          return
        }
        this.store.addDiagnostic(
          'info',
          `IBKR raw openOrder orderId=${orderId} status=${String(orderState.status ?? '') || 'unknown'} symbol=${String(contract.symbol ?? '') || 'unknown'} warning=${String(orderState.warningText ?? '') || '-'}`,
        )
        const converted = fromIbOpenOrder(orderId, contract, order, orderState)
        const adoption = this.adoptOwnedReadback(converted, contract)
        if (adoption.rejected) return
        const recovered = adoption.order
        const existing = this.existingForOwnedReadback(
          converted,
          recovered,
          this.findBrokerOrder(orderId, order.permId, order.clientId, order.account),
        )
        if ((order.clientId ?? this.config.ibkrClientId) === this.config.ibkrClientId)
          this.pendingModifications.delete(orderId)
        const incoming = recovered ?? converted
        incoming.id = recovered?.id ?? existing?.id ?? this.safeReadbackOrderId(orderId, order)
        if (!Number.isInteger(orderId) || orderId === 0) incoming.brokerOrderId = undefined
        this.snapshotOrders.add(incoming.id)
        const reconciledSymbol =
          recovered?.symbol ?? this.symbolFromContract(contract, existing?.symbol)
        const symbol = existing
          ? {
              ...reconciledSymbol,
              exchange: existing.symbol.exchange,
              primaryExchange: existing.symbol.primaryExchange,
            }
          : reconciledSymbol
        this.store.upsertOrder({
          ...incoming,
          symbol,
          status: reconciledOrderStatus(
            existing?.status,
            mapOrderStatus(
              String(orderState.status ?? 'working'),
              existing?.filledQuantity,
              existing?.remainingQuantity,
            ),
          ),
          quantity: incoming.quantity > 0 ? incoming.quantity : (existing?.quantity ?? 0),
          durationDateTime: incoming.durationDateTime ?? existing?.durationDateTime,
          filledQuantity: existing?.filledQuantity ?? incoming.filledQuantity,
          remainingQuantity: existing?.remainingQuantity ?? incoming.remainingQuantity,
          avgFillPrice: existing?.avgFillPrice ?? incoming.avgFillPrice,
          optionLegs: existing?.optionLegs ?? incoming.optionLegs,
          strategyLegs: existing?.strategyLegs ?? incoming.strategyLegs,
          parentId: incoming.parentId ?? existing?.parentId,
          parentType: incoming.parentType ?? existing?.parentType,
          bracketGroupId: incoming.bracketGroupId ?? existing?.bracketGroupId,
          brokerOrderTypeId: incoming.brokerOrderTypeId ?? existing?.brokerOrderTypeId,
          stopType: incoming.stopType ?? existing?.stopType,
          guaranteedStop: incoming.guaranteedStop ?? existing?.guaranteedStop,
          trailingStopPips:
            incoming.customFields?.ibkrTrailingAmount !== undefined ||
            incoming.trailPercent !== undefined
              ? incoming.trailingStopPips
              : (incoming.trailingStopPips ?? existing?.trailingStopPips),
          exits: incoming.exits ?? existing?.exits,
          exitLevelId: incoming.exitLevelId ?? existing?.exitLevelId,
          takeProfitOutsideRth: incoming.takeProfitOutsideRth ?? existing?.takeProfitOutsideRth,
          confirmId: incoming.confirmId ?? existing?.confirmId,
          customFields: {
            ...existing?.customFields,
            ...incoming.customFields,
            ibkrMissingOpenOrder: false,
            ibkrSecurityType: contract.secType,
          },
          message: incoming.message ?? existing?.message,
          submittedAt: existing?.submittedAt ?? incoming.submittedAt,
        })
        this.recordOwnedReadback(incoming.id)
      },
    )
    this.ib.on(
      EventName.completedOrder,
      (contract: Contract, ibOrder: IbOrder, orderState: OrderState) => {
        const orderId = ibOrder.orderId
        const permId = positiveContractId(ibOrder.permId)
        if (
          (orderId === undefined || !Number.isInteger(orderId) || orderId === 0) &&
          permId === undefined
        ) {
          this.store.addDiagnostic(
            'warning',
            `IBKR completedOrder omitted its API order id for ${String(contract.symbol ?? '') || 'unknown'}`,
          )
          return
        }
        if (!this.config.allowedAccountIds.includes(String(ibOrder.account ?? ''))) return
        if (orderId !== undefined && orderId > 0) this.orderIds.observeUsed(orderId)
        const converted = fromIbOpenOrder(orderId ?? 0, contract, ibOrder, orderState)
        const adoption = this.adoptOwnedReadback(converted, contract)
        if (adoption.rejected) return
        const recovered = adoption.order
        const existing = this.existingForOwnedReadback(
          converted,
          recovered,
          this.findBrokerOrder(orderId, permId, ibOrder.clientId, ibOrder.account),
        )
        const incoming = recovered ?? converted
        incoming.id =
          recovered?.id ?? existing?.id ?? this.safeReadbackOrderId(orderId ?? 0, ibOrder)
        if (orderId === undefined || !Number.isInteger(orderId) || orderId === 0)
          incoming.brokerOrderId = existing?.brokerOrderId
        const status = reconciledOrderStatus(existing?.status, completedOrderStatus(orderState))
        // Completed-order readback reports totalQuantity 0; a filled order's size is its fill.
        const quantity =
          positiveNumber(incoming.quantity) ??
          positiveNumber(existing?.quantity) ??
          (status === 'filled' ? positiveNumber(ibOrder.filledQuantity) : undefined) ??
          0
        const completedAt = orderState.completedTime
          ? parseIbExecutionTime(orderState.completedTime)
          : undefined
        const filledQuantity =
          status === 'filled'
            ? Math.max(existing?.filledQuantity ?? 0, quantity)
            : existing?.filledQuantity
        this.store.upsertOrder({
          ...incoming,
          status,
          symbol: recovered?.symbol ?? this.symbolFromContract(contract, existing?.symbol),
          quantity,
          filledQuantity,
          remainingQuantity:
            status === 'filled' ? 0 : (existing?.remainingQuantity ?? incoming.remainingQuantity),
          avgFillPrice: existing?.avgFillPrice ?? incoming.avgFillPrice,
          optionLegs: existing?.optionLegs ?? incoming.optionLegs,
          strategyLegs: existing?.strategyLegs ?? incoming.strategyLegs,
          parentId: incoming.parentId ?? existing?.parentId,
          parentType: incoming.parentType ?? existing?.parentType,
          bracketGroupId: incoming.bracketGroupId ?? existing?.bracketGroupId,
          brokerOrderTypeId: incoming.brokerOrderTypeId ?? existing?.brokerOrderTypeId,
          stopType: incoming.stopType ?? existing?.stopType,
          guaranteedStop: incoming.guaranteedStop ?? existing?.guaranteedStop,
          trailingStopPips:
            incoming.customFields?.ibkrTrailingAmount !== undefined ||
            incoming.trailPercent !== undefined
              ? incoming.trailingStopPips
              : (incoming.trailingStopPips ?? existing?.trailingStopPips),
          exits: incoming.exits ?? existing?.exits,
          exitLevelId: incoming.exitLevelId ?? existing?.exitLevelId,
          takeProfitOutsideRth: incoming.takeProfitOutsideRth ?? existing?.takeProfitOutsideRth,
          confirmId: incoming.confirmId ?? existing?.confirmId,
          customFields: {
            ...existing?.customFields,
            ...incoming.customFields,
            ibkrCompleted: true,
            ibkrMissingOpenOrder: false,
            ibkrCompletedStatus: orderState.completedStatus ?? orderState.status,
            ibkrSecurityType: contract.secType,
          },
          message: incoming.message,
          // IBKR does not report when a completed order was submitted; never stamp the readback time.
          submittedAt: existing?.submittedAt ?? recovered?.submittedAt,
          updatedAt:
            completedAt === undefined
              ? (existing?.updatedAt ?? new Date().toISOString())
              : new Date(completedAt).toISOString(),
        })
        this.recordOwnedReadback(incoming.id)
      },
    )
    this.ib.on(
      EventName.orderStatus,
      (
        orderId: number,
        status: string,
        filled: number,
        remaining: number,
        avgFillPrice: number,
        permId?: number,
        _parentId?: number,
        _lastFillPrice?: number,
        clientId?: number,
      ) => {
        this.orderIds.observeUsed(orderId)
        if (this.previews.whatIfOrderIds.has(orderId)) return
        this.store.addDiagnostic(
          'info',
          `IBKR raw orderStatus orderId=${orderId} status=${status} filled=${filled} remaining=${remaining} avgFillPrice=${avgFillPrice}`,
        )
        const existing = this.findBrokerOrder(orderId, permId, clientId)
        if (!existing) return
        if (
          existing.customFields?.[PAPER_OWNER_FIELD] !== undefined &&
          (clientId !== this.config.ibkrClientId ||
            (existing.customFields?.ibkrOwnershipRestored === true &&
              (positiveContractId(existing.permId) === undefined || permId !== existing.permId)))
        )
          return
        const reconciledFilled = Math.max(
          existing.filledQuantity ?? 0,
          Number.isFinite(filled) && filled >= 0 ? filled : 0,
        )
        const reconciledRemaining =
          existing.status === 'filled' || mapOrderStatus(status) === 'filled'
            ? 0
            : mapOrderStatus(status) === 'cancelled' && Number.isFinite(remaining) && remaining >= 0
              ? remaining
              : existing.quantity > 0
                ? Math.max(0, existing.quantity - reconciledFilled)
                : Number.isFinite(remaining) && remaining >= 0
                  ? remaining
                  : existing.remainingQuantity
        const incomingStatus = mapOrderStatus(status, reconciledFilled, reconciledRemaining)
        const mappedStatus = reconciledOrderStatus(existing.status, incomingStatus)
        const previousStatus = existing.status
        const normalizedAvgFillPrice =
          Number.isFinite(avgFillPrice) &&
          avgFillPrice > 0 &&
          Number.isFinite(filled) &&
          filled >= (existing.filledQuantity ?? 0)
            ? avgFillPrice
            : existing.avgFillPrice !== undefined && existing.avgFillPrice > 0
              ? existing.avgFillPrice
              : undefined
        this.store.upsertOrder({
          ...existing,
          permId: positiveContractId(permId) ?? existing.permId,
          clientId: clientId ?? existing.clientId,
          status: mappedStatus,
          message:
            mappedStatus === 'cancelled' || mappedStatus === 'filled'
              ? undefined
              : existing.message,
          filledQuantity: reconciledFilled,
          remainingQuantity: reconciledRemaining,
          avgFillPrice: normalizedAvgFillPrice,
          updatedAt: new Date().toISOString(),
        })
        if (mappedStatus !== previousStatus) {
          if (mappedStatus === 'cancelled') {
            setTimeout(() => {
              const cancelled = this.store
                .getState()
                .ordersHistory?.find((order) => order.id === String(orderId))
              if (cancelled?.status === 'cancelled') {
                this.store.addMessage(
                  'info',
                  `Order ${orderId} status changed from ${previousStatus} to cancelled`,
                )
              }
            }, ORDER_CANCELLATION_REASON_WAIT_MS)
            return
          }
          const fillText =
            mappedStatus === 'filled' && Number.isFinite(avgFillPrice) && avgFillPrice > 0
              ? ` at ${avgFillPrice}`
              : ''
          this.store.addMessage(
            'info',
            `Order ${orderId} status changed from ${previousStatus} to ${mappedStatus}${fillText}`,
          )
        }
      },
    )
    this.ib.on(
      EventName.execDetails,
      (_requestId: number, contract: Contract, execution: IbExecution) => {
        this.store.addDiagnostic(
          'info',
          `IBKR raw execDetails orderId=${String(execution.orderId ?? 'unknown')} execId=${String(execution.execId ?? 'unknown')} symbol=${String(contract.symbol ?? '') || 'unknown'} side=${String(execution.side ?? '') || 'unknown'} shares=${Number(execution.shares ?? 0)} price=${Number(execution.price ?? 0)}`,
        )
        const candidate = this.orderForExecution(execution)
        const accountId = execution.acctNumber ?? candidate?.accountId
        const converted = fromIbExecution(contract, execution, accountId)
        let ownedExecution: ReturnType<PaperOwnershipJournal['recordExecution']>
        try {
          const exactOwned =
            execution.orderRef?.startsWith('tspe:') ||
            (candidate?.customFields?.[PAPER_OWNER_FIELD] !== undefined &&
              positiveContractId(execution.permId) !== undefined &&
              candidate.permId === execution.permId)
          if (
            exactOwned &&
            (!execution.acctNumber ||
              !execution.execId ||
              !['BOT', 'SLD'].includes(String(execution.side)))
          )
            throw new Error(
              'Owned execution lacks exact broker account, execution identity or direction.',
            )
          ownedExecution = execution.acctNumber
            ? this.ownership?.recordExecution(converted)
            : undefined
          if (
            this.ownership &&
            !ownedExecution &&
            candidate?.customFields?.[PAPER_OWNER_FIELD] !== undefined &&
            execution.acctNumber === candidate.accountId &&
            (execution.orderRef === candidate.brokerOrderRef ||
              (positiveContractId(execution.permId) !== undefined &&
                execution.permId === candidate.permId))
          )
            return // A stale owned correction must not be relabelled as an unowned fill.
        } catch {
          this.unknownOwnedReadback(converted)
          return
        }
        const state = this.store.getState()
        const order = ownedExecution
          ? [...state.orders, ...(state.ordersHistory ?? [])].find(
              (item) => item.id === ownedExecution.orderId,
            )
          : candidate?.customFields?.[PAPER_OWNER_FIELD] !== undefined
            ? undefined
            : candidate
        const incoming = ownedExecution ?? converted
        const symbol = ownedExecution?.symbol ?? this.symbolFromContract(contract, order?.symbol)
        const reconciledExecution = {
          ...incoming,
          orderId:
            order?.id ??
            this.safeReadbackOrderId(execution.orderId ?? 0, {
              permId: execution.permId,
              clientId: execution.clientId,
              account: accountId,
            }),
          symbol,
          optionContract: optionContractWithSourceIdentity(incoming.optionContract, symbol),
        }
        const retained = this.store.upsertExecution(reconciledExecution)
        if (order && retained) this.reconcileOrderFromExecution(order, contract, execution)
      },
    )
  }

  private orderForExecution(execution: IbExecution): Order | undefined {
    return this.findBrokerOrder(
      execution.orderId,
      execution.permId,
      execution.clientId,
      execution.acctNumber,
    )
  }

  private findBrokerOrder(
    orderId?: number,
    permId?: number,
    clientId?: number,
    accountId?: string,
  ): Order | undefined {
    const state = this.store.getState()
    const orders = [...state.orders, ...(state.ordersHistory ?? [])].filter(
      (order) => !accountId || order.accountId === accountId,
    )
    if (positiveContractId(permId) !== undefined) {
      const matches = orders.filter((order) => order.permId === permId)
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) return undefined
    }
    if (orderId === undefined || !Number.isInteger(orderId) || orderId === 0) return undefined
    const matches = orders.filter(
      (order) =>
        (order.brokerOrderId === orderId || order.id === String(orderId)) &&
        (clientId === undefined || (order.clientId ?? this.config.ibkrClientId) === clientId) &&
        (positiveContractId(permId) === undefined ||
          order.permId === undefined ||
          order.permId === permId),
    )
    return matches.length === 1 ? matches[0] : undefined
  }

  private readbackOrderId(
    orderId: number,
    order: {
      permId?: number | undefined
      clientId?: number | undefined
      account?: string | undefined
    },
  ): string {
    if (orderId > 0 && (order.clientId ?? this.config.ibkrClientId) === this.config.ibkrClientId)
      return String(orderId)
    if (positiveContractId(order.permId) !== undefined) return `perm:${order.permId}`
    return `api:${order.clientId ?? 'unknown'}:${orderId}:${order.account ?? ''}`
  }

  beginReconciliation(): void {
    this.reconciliationVersion++
    this.snapshotOrders.clear()
    this.ownership?.beginReconciliation()
  }

  finishReconciliation(): void {
    for (const order of this.store.getState().orders) {
      if (this.snapshotOrders.has(order.id) || order.customFields?.ibkrMissingOpenOrder === true)
        continue
      this.store.upsertOrder({
        ...order,
        status: 'inactive',
        message:
          'Order is absent from the reconciled IBKR open-order snapshot. Its final status is unconfirmed; check TWS history.',
        customFields: { ...order.customFields, ibkrMissingOpenOrder: true },
        updatedAt: new Date().toISOString(),
      })
    }
    this.ownership?.finishReconciliation()
  }

  private existingForOwnedReadback(
    incoming: Order,
    recovered: Order | undefined,
    candidate: Order | undefined,
  ): Order | undefined {
    if (recovered) {
      const state = this.store.getState()
      return [...state.orders, ...(state.ordersHistory ?? [])].find(
        (order) => order.id === recovered.id,
      )
    }
    if (candidate?.customFields?.[PAPER_OWNER_FIELD] !== undefined) return undefined
    // An arbitrary native OrderRef never becomes ownership without durable intent.
    return incoming.brokerOrderRef?.startsWith('tspe:') ? undefined : candidate
  }

  private unknownOwnedReadback(
    binding: Pick<Order, 'brokerOrderRef' | 'permId' | 'accountId'>,
  ): void {
    try {
      this.ownership?.markUnknown(binding)
    } catch {
      /* Persistence failure already blocks dispatch. */
    }
    const state = this.store.getState()
    for (const order of [...state.orders, ...(state.ordersHistory ?? [])]) {
      if (
        order.customFields?.[PAPER_OWNER_FIELD] === undefined ||
        order.customFields.ibkrOwnershipContradiction === true
      )
        continue
      if (
        binding.brokerOrderRef
          ? order.brokerOrderRef !== binding.brokerOrderRef
          : order.permId !== binding.permId ||
            order.accountId !== binding.accountId ||
            !positiveContractId(binding.permId)
      )
        continue
      this.store.upsertOrder({
        ...order,
        customFields: { ...order.customFields, ibkrOwnershipContradiction: true },
      })
    }
    this.store.addDiagnostic(
      'error',
      'Native paper ownership facts conflict or are unavailable; recovery remains unknown.',
    )
  }

  private adoptOwnedReadback(
    incoming: Order,
    contract: Contract,
  ): { order?: Order; rejected: boolean } {
    try {
      const order = this.ownership?.adoptOrder(incoming, contract)
      return { ...(order ? { order } : {}), rejected: false }
    } catch {
      this.unknownOwnedReadback(incoming)
      return { rejected: true }
    }
  }

  private recordOwnedReadback(orderId: string): void {
    const state = this.store.getState(),
      order = [...state.orders, ...(state.ordersHistory ?? [])].find((item) => item.id === orderId)
    if (!order) return
    try {
      this.ownership?.recordOrder(order, true)
    } catch {
      this.unknownOwnedReadback(order)
    }
  }

  private safeReadbackOrderId(
    orderId: number,
    order: {
      permId?: number | undefined
      clientId?: number | undefined
      account?: string | undefined
    },
  ): string {
    const id = this.readbackOrderId(orderId, order),
      state = this.store.getState()
    if (
      [...state.orders, ...(state.ordersHistory ?? [])].some(
        (existing) =>
          existing.id === id && existing.customFields?.[PAPER_OWNER_FIELD] !== undefined,
      )
    )
      return positiveContractId(order.permId) === undefined
        ? `unowned-api:${order.clientId ?? 'unknown'}:${orderId}:${order.account ?? ''}`
        : `perm:${order.permId}`
    return id
  }

  paperOwnershipRecovery(ownerId: string): PaperOwnershipRecovery {
    if (this.config.ibkrMode !== 'paper' || !this.ownership)
      throw new RequestError(404, 'Durable paper ownership recovery is unavailable.')
    try {
      const snapshot = this.ownership.recovery(ownerId)
      for (const order of snapshot.orders) this.assertAccountAllowed(order.accountId)
      return snapshot
    } catch (error) {
      if (error instanceof RequestError) throw error
      throw new RequestError(409, error instanceof Error ? error.message : 'Ownership is unknown.')
    }
  }

  reconcilePaperOwnership(ownerId: string): Promise<PaperOwnershipRecovery> {
    const pending = this.ownershipReplays.get(ownerId)
    if (pending) return pending
    const replay = this.replayPaperOwnership(ownerId).finally(() =>
      this.ownershipReplays.delete(ownerId),
    )
    this.ownershipReplays.set(ownerId, replay)
    return replay
  }

  private async replayPaperOwnership(ownerId: string): Promise<PaperOwnershipRecovery> {
    const snapshot = this.paperOwnershipRecovery(ownerId)
    if (!snapshot.reconciled || this.store.getState().connectionStatus !== 'connected')
      throw new RequestError(503, 'Paper ownership awaits complete broker reconciliation.')
    if (
      snapshot.outcome !== 'known' ||
      snapshot.orders.some(
        (order) =>
          !['filled', 'cancelled', 'rejected', 'inactive'].includes(order.status) ||
          order.customFields?.ibkrMissingOpenOrder === true,
      )
    )
      throw new RequestError(
        409,
        'Owned orders must have confirmed terminal state before fill replay.',
      )
    const accounts = new Set(snapshot.orders.map((order) => order.accountId))
    if (accounts.size !== 1 || !snapshot.orders[0]?.accountId)
      throw new RequestError(409, 'Ownership replay has ambiguous account authority.')
    const accountId = snapshot.orders[0].accountId
    const reconciliationVersion = this.reconciliationVersion
    this.assertAccountAllowed(accountId)
    const requestId = this.orderIds.allocateRequestId()
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        this.ib.off(EventName.execDetailsEnd, ended)
        this.ib.off(EventName.error, failed)
        error ? reject(error) : resolve()
      }
      const ended = (id: number) => {
        if (id === requestId) finish()
      }
      const failed = (error: Error, _code: number, id: number) => {
        if (id === requestId) finish(error)
      }
      const timer = setTimeout(
        () =>
          finish(
            new RequestError(504, 'Owned execution replay timed out; fill outcome is unknown.'),
          ),
        15_000,
      )
      this.ib.on(EventName.execDetailsEnd, ended)
      this.ib.on(EventName.error, failed)
      try {
        this.ib.reqExecutions(requestId, {
          acctCode: accountId,
          clientId: String(this.config.ibkrClientId),
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Owned execution replay failed.'))
      }
    })
    if (
      this.store.getState().connectionStatus !== 'connected' ||
      this.reconciliationVersion !== reconciliationVersion
    )
      throw new RequestError(503, 'Broker connection changed during ownership replay.')
    this.ownership!.finishExecutionReplay(ownerId)
    return this.paperOwnershipRecovery(ownerId)
  }

  private validatedOwnershipId(value: unknown): string | undefined {
    try {
      const id = paperOwnershipId(value)
      if (!id) return undefined
      if (this.config.ibkrMode !== 'paper')
        throw new RequestError(400, 'Paper ownership cannot be used on a Live connection.')
      if (!this.ownership)
        throw new RequestError(503, 'Durable paper ownership must be ready before dispatch.')
      return id
    } catch (error) {
      if (error instanceof RequestError) throw error
      throw new RequestError(400, error instanceof Error ? error.message : 'Invalid ownership.')
    }
  }

  private ownershipDraft(draft: OrderDraft): void {
    this.validatedOwnershipId(draft.customFields?.[PAPER_OWNER_FIELD])
  }

  private reconcileOrderFromExecution(order: Order, contract: Contract, raw: IbExecution): void {
    const multiLeg =
      order.customFields?.ibkrSecurityType === SecType.BAG ||
      (order.optionLegs?.length ?? 0) > 1 ||
      (order.strategyLegs?.length ?? 0) > 1
    if (multiLeg && String(contract.secType ?? '').toUpperCase() !== SecType.BAG) return
    const cumulativeQuantity = Number(raw.cumQty)
    const hasCumulativeQuantity = Number.isFinite(cumulativeQuantity) && cumulativeQuantity >= 0
    // Parent combo quantity cannot be reconstructed by summing its individual leg executions.
    if (multiLeg && !hasCumulativeQuantity) return

    const submittedAt = order.submittedAt === undefined ? Number.NaN : Date.parse(order.submittedAt)
    const related = this.store.getState().executions.filter((candidate) => {
      const orderMatches = candidate.orderId === order.id
      const accountMatches =
        !candidate.accountId || !order.accountId || candidate.accountId === order.accountId
      const executedAt = Date.parse(candidate.timestamp)
      const timeMatches =
        !Number.isFinite(submittedAt) || !Number.isFinite(executedAt) || executedAt >= submittedAt
      return orderMatches && accountMatches && timeMatches
    })
    const aggregateQuantity = related.reduce(
      (total, candidate) =>
        total +
        (Number.isFinite(candidate.quantity) && candidate.quantity > 0 ? candidate.quantity : 0),
      0,
    )
    const reportedQuantity = hasCumulativeQuantity ? cumulativeQuantity : aggregateQuantity
    const filledQuantity = Math.max(order.filledQuantity ?? 0, reportedQuantity)
    if (filledQuantity <= 0) return

    const aggregateNotional = related.reduce(
      (total, candidate) =>
        total +
        (candidate.quantity > 0 && candidate.price > 0 ? candidate.quantity * candidate.price : 0),
      0,
    )
    const reportedAverage = Number(raw.avgPrice)
    const avgFillPrice =
      reportedQuantity < (order.filledQuantity ?? 0)
        ? aggregateQuantity >= (order.filledQuantity ?? 0) && aggregateNotional > 0
          ? aggregateNotional / aggregateQuantity
          : order.avgFillPrice
        : Number.isFinite(reportedAverage) && reportedAverage > 0
          ? reportedAverage
          : aggregateQuantity > 0 && aggregateNotional > 0
            ? aggregateNotional / aggregateQuantity
            : order.avgFillPrice
    const hasQuantity = Number.isFinite(order.quantity) && order.quantity > 0
    const remainingQuantity = hasQuantity
      ? Math.max(0, order.quantity - filledQuantity)
      : order.remainingQuantity
    const active =
      order.status === 'placing' ||
      order.status === 'pre-submitted' ||
      order.status === 'working' ||
      order.status === 'partially-filled'
    const status = active
      ? hasQuantity && remainingQuantity === 0
        ? 'filled'
        : 'partially-filled'
      : order.status
    this.store.upsertOrder({
      ...order,
      status,
      filledQuantity,
      remainingQuantity,
      avgFillPrice,
      message: status === 'filled' ? undefined : order.message,
      // Executions replayed after a restart do not change when a completed order last changed.
      updatedAt: active ? new Date().toISOString() : order.updatedAt,
    })
    if (status !== order.status) {
      const fillText = avgFillPrice !== undefined ? ` at ${avgFillPrice}` : ''
      this.store.addMessage(
        'info',
        `Order ${order.id} status changed from ${order.status} to ${status}${fillText}`,
      )
    }
  }

  private readonly sourceSymbolsByContractId = new Map<number, SourceSymbolIdentity>()

  private readonly sourceSymbolsByRoute = new Map<string, Map<string, SourceSymbolIdentity>>()

  async previewOrder(draft: OrderDraft, context: BrokerContext = {}): Promise<OrderPreviewResult> {
    const validation = validateDraft(draft)
    if (!validation.accepted) return validation
    if (this.store.getState().connectionStatus !== 'connected') {
      return { accepted: false, reason: 'IBKR is disconnected. Order not sent.' }
    }
    const accountSafety = this.validateAccount(
      context.accountId ?? draft.accountId ?? this.store.getState().activeAccountId,
    )
    if (!accountSafety.accepted) return accountSafety
    if (
      !hasOptionLegs(draft) &&
      !hasStrategyLegs(draft) &&
      ['futures', 'bond', 'warrant', 'commodity', 'cfd', 'event-contract'].includes(
        draft.symbol.assetClass ?? '',
      )
    ) {
      try {
        const details = await this.requests.requestContractDetails(toIbContract(draft.symbol))
        if (details.length !== 1)
          return { accepted: false, reason: 'Order must resolve to one exact IBKR contract.' }
        const detail = details[0]!
        const qualified = fromIbSymbol(detail.contract)
        if (
          !qualified.currency ||
          qualified.currency !== draft.symbol.currency ||
          qualified.assetClass !== draft.symbol.assetClass
        ) {
          return {
            accepted: false,
            reason:
              'IBKR contract currency or instrument classification is missing or differs from the order.',
          }
        }
        if (detail.minSize !== undefined && draft.quantity < detail.minSize)
          return { accepted: false, reason: `IBKR minimum order quantity is ${detail.minSize}.` }
        if (
          detail.sizeIncrement &&
          Math.abs(
            draft.quantity / detail.sizeIncrement -
              Math.round(draft.quantity / detail.sizeIncrement),
          ) > 1e-7
        )
          return { accepted: false, reason: `IBKR quantity increment is ${detail.sizeIncrement}.` }
        draft = { ...draft, symbol: { ...qualified, sourceSymbol: draft.symbol.sourceSymbol } }
      } catch (error) {
        return { accepted: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
    const priceRejection = await this.validateNativeOrderPrices(draft)
    if (priceRejection) return { accepted: false, reason: priceRejection }
    if (this.previews.canUseIbkrWhatIfPreview(draft)) {
      try {
        if (draft.exits?.levels.length)
          return await this.previews.previewBracketWithIbkrWhatIf(draft, context)
        return await this.previews.previewOrderWithIbkrWhatIf(draft, context)
      } catch (error) {
        return {
          accepted: false,
          source: 'broker',
          reason: isOrderPreviewUnavailableError(error)
            ? 'IBKR order preview timed out. Order not sent. Retry when IBKR preview is available.'
            : error instanceof Error
              ? error.message
              : String(error),
        }
      }
    }
    return this.previews.localOrderPreview(draft, context)
  }

  private async validateNativeOrderPrices(draft: OrderDraft): Promise<string | undefined> {
    try {
      let target =
        hasOptionLegs(draft) || hasStrategyLegs(draft)
          ? (await this.resolveStrategyOrderTarget(strategyLegsForDraft(draft), draft.side))
              .contract
          : toIbContract(draft.symbol, draft.duration, draft.routingDestination)
      target = applyOrderRoutingDestination(target, draft.routingDestination, draft.duration)
      const details = await this.requests.requestContractDetails(target)
      const matches =
        target.conId !== undefined
          ? details.filter((item) => item.contract.conId === target.conId)
          : details
      if (matches.length !== 1)
        return 'IBKR order price rule requires one exact qualified contract.'
      const detail = matches[0]!
      if (target.secType !== SecType.BAG && !positiveContractId(detail.contract.conId))
        return 'IBKR order price rule requires an exact native contract ID.'
      if (
        detail.contract.secType !== target.secType ||
        detail.contract.currency !== target.currency ||
        (target.conId !== undefined && detail.contract.conId !== target.conId) ||
        (target.conId === undefined && detail.contract.symbol !== target.symbol)
      )
        return 'IBKR order price rule contract identity differs from the proposed order.'
      if (
        target.secType === SecType.BAG &&
        JSON.stringify(detail.contract.comboLegs) !== JSON.stringify(target.comboLegs)
      )
        return 'IBKR strategy net price rule is unavailable for the exact native combo.'
      const units = nativeMonetaryUnits(detail)
      if (units.monetaryValueAvailable === false) return units.monetaryValueUnavailableReason
      if (!orderHasPricedFields(draft)) return undefined
      const id = selectedMarketRuleId(detail, target.exchange)
      if (id === undefined || !this.requests.requestMarketRule)
        return 'IBKR selected-route order price rule is unavailable. Order not sent.'
      const bands = authoritativePriceIncrements(await this.requests.requestMarketRule(id))
      if (!bands) return 'IBKR selected-route order price rule is invalid. Order not sent.'
      return orderPriceIncrementRejection(draft, bands)
    } catch (error) {
      return `IBKR order price rule is unavailable. ${error instanceof Error ? error.message : 'Order not sent.'}`
    }
  }

  async previewModifyOrder(
    orderId: string,
    patch: OrderPatch,
    context: BrokerContext = {},
  ): Promise<OrderPreviewResult> {
    const existing = this.store.getState().orders.find((order) => order.id === orderId)
    if (!existing) throw new RequestError(404, `Order ${orderId} was not found`)
    return this.previewOrder(
      applyOrderPatch(existing, patch),
      this.modificationContext(existing, patch, context),
    )
  }

  async placeOrder(draft: OrderDraft, context: BrokerContext = {}): Promise<PlaceOrderResult> {
    this.ownershipDraft(draft)
    if (draft.exits?.levels.length) {
      return this.placeOrderWithExits(draft, context)
    }
    if (hasStrategyLegs(draft) || hasOptionLegs(draft)) {
      return this.placeStrategyOrder(draft, context)
    }
    const preview = await this.previewOrder(draft, context)
    if (!preview.accepted) {
      throw new RequestError(400, preview.reason ?? 'Order rejected by preview')
    }
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }

    const orderId = await this.allocateOrderId()
    const submittedAt = new Date().toISOString()
    let order: Order = {
      ...draft,
      accountId: context.accountId ?? draft.accountId ?? this.store.getState().activeAccountId,
      id: String(orderId),
      brokerOrderId: orderId,
      status: 'placing',
      submittedAt,
      updatedAt: submittedAt,
      remainingQuantity: draft.quantity,
    }
    const contract = toIbContract(draft.symbol, draft.duration, draft.routingDestination)
    order = this.ownership?.prepare(order, contract) ?? order
    this.store.upsertOrder(order)
    this.rememberSourceSymbol(contract, draft.symbol)
    this.ib.placeOrder(
      orderId,
      contract,
      toIbOrder(
        orderId,
        order,
        true,
        this.config.ibkrMode === 'paper' && order.symbol.assetClass === 'futures'
          ? { overridePercentageConstraints: true }
          : {},
      ),
    )
    this.store.addMessage(
      'info',
      `Submitted ${draft.side} ${draft.quantity} ${draft.symbol.symbol} ${draft.type} order ${orderId}; awaiting IBKR acknowledgement`,
    )
    return { order, preview }
  }

  private async placeStrategyOrder(
    draft: OrderDraft,
    context: BrokerContext,
  ): Promise<PlaceOrderResult> {
    const preview = await this.previewOrder(draft, context)
    if (!preview.accepted) {
      throw new RequestError(400, preview.reason ?? 'Strategy order rejected by preview')
    }
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }

    const strategyTarget = await this.resolveStrategyOrderTarget(
      strategyLegsForDraft(draft),
      draft.side,
    )
    const orderId = await this.allocateOrderId()
    const submittedAt = new Date().toISOString()
    let order: Order = {
      ...draft,
      accountId: context.accountId ?? draft.accountId ?? this.store.getState().activeAccountId,
      side: draft.side,
      quantity: draft.quantity,
      id: String(orderId),
      brokerOrderId: orderId,
      status: 'placing',
      submittedAt,
      updatedAt: submittedAt,
      remainingQuantity: strategyTarget.quantity,
    }
    const routedContract = applyOrderRoutingDestination(
      strategyTarget.contract,
      draft.routingDestination,
      draft.duration,
    )
    order =
      this.ownership?.prepare(order, routedContract, strategyTarget.providerContracts) ?? order
    this.store.upsertOrder(order)
    this.rememberSourceSymbol(routedContract, draft.symbol)
    const strategyOptions: IbOrderOverrideOptions =
      this.config.ibkrMode === 'paper' ? { overridePercentageConstraints: true } : {}
    this.ib.placeOrder(orderId, routedContract, toIbOrder(orderId, order, true, strategyOptions))
    this.store.addMessage(
      'info',
      `Submitted ${strategyTarget.description} ${order.type} order ${orderId}; awaiting IBKR acknowledgement`,
    )
    return { order, preview }
  }

  private async resolveStrategyOrderTarget(
    strategyLegs: StrategyOrderLegDraft[],
    parentSide: Order['side'],
  ): Promise<{
    contract: Contract
    side: Order['side']
    quantity: number
    description: string
    providerContracts: Contract[]
  }> {
    if (!strategyLegs.length)
      throw new RequestError(400, 'Strategy order requires at least one leg.')
    const resolved = await Promise.all(
      strategyLegs.map(async (source) => {
        if (source.instrument === 'option') {
          const option = await this.resolveOptionLeg(source)
          return { source, contract: option.contract, providerContract: option.providerContract }
        }
        const query = toIbContract(source.symbolInfo)
        const details = await this.requests.requestContractDetails(query)
        const match = details.find((item) => item.contract?.conId != null)
        if (!match?.contract?.conId)
          throw new RequestError(404, `IBKR stock contract was not found for ${source.symbol}.`)
        const resolvedContract = { ...query, ...match.contract, conId: match.contract.conId }
        this.rememberSourceSymbol(resolvedContract, source.symbolInfo)
        return { source, contract: resolvedContract, providerContract: match.contract }
      }),
    )
    const firstResolved = resolved[0]
    if (resolved.length === 1 && firstResolved?.source.instrument === 'option') {
      return {
        contract: firstResolved.contract,
        side: firstResolved.source.side,
        quantity: firstResolved.source.quantity,
        description: `option ${describeOptionLeg(firstResolved.source)}`,
        providerContracts: [firstResolved.providerContract],
      }
    }
    const optionLeg = strategyLegs.find(
      (leg): leg is Extract<StrategyOrderLegDraft, { instrument: 'option' }> =>
        leg.instrument === 'option',
    )
    const equityLeg = strategyLegs.find(
      (leg): leg is Extract<StrategyOrderLegDraft, { instrument: 'equity' }> =>
        leg.instrument === 'equity',
    )
    const symbol = optionLeg?.contract.underlying ?? equityLeg?.symbol
    if (!symbol) throw new RequestError(400, 'Strategy order requires an underlying symbol.')
    const side = parentSide
    const comboLegs: ComboLeg[] = resolved.map(({ source, contract }) => ({
      conId: contract.conId,
      ratio: source.ratio ?? 1,
      // A SELL parent reverses the contract legs at IBKR; encode relative leg directions.
      action: source.side === side ? OrderAction.BUY : OrderAction.SELL,
      exchange:
        source.instrument === 'option'
          ? source.contract.route || source.contract.exchange || contract.exchange || 'SMART'
          : source.exchange || contract.exchange || 'SMART',
      openClose: source.positionEffect === 'open' ? 1 : 2,
    }))
    return {
      contract: {
        symbol: symbol.toUpperCase(),
        secType: SecType.BAG,
        exchange: 'SMART',
        currency: optionLeg?.contract.currency ?? equityLeg?.currency ?? 'USD',
        comboLegs,
      },
      side,
      quantity: strategyOrderQuantity(strategyLegs),
      description: `${strategyLegs.length}-leg ${symbol.toUpperCase()} strategy`,
      providerContracts: resolved.map((item) => item.providerContract),
    }
  }

  private async resolveOptionLeg(leg: OptionOrderLegDraft): Promise<{
    source: OptionOrderLegDraft
    contract: Contract & { conId: number }
    providerContract: Contract
  }> {
    const query = toIbOptionContract(leg.contract)
    const wireExpiry = query.lastTradeDateOrContractMonth
    if (wireExpiry === undefined) throw new RequestError(400, 'Option expiry is required.')
    const details = await this.requests.requestContractDetails(query)
    const match = selectExactOptionDetails(details, query)
    return {
      source: leg,
      providerContract: match.contract,
      contract: {
        ...query,
        ...match.contract,
        conId: match.contract.conId,
        // ContractDetails can append a time/zone to expiry; retain that raw term
        // in providerContract while requalification and order wire use the query date.
        lastTradeDateOrContractMonth: wireExpiry,
        exchange: leg.contract.route || leg.contract.exchange || match.contract.exchange || 'SMART',
        currency: leg.contract.currency ?? match.contract.currency ?? 'USD',
      },
    }
  }

  private async placeOrderWithExits(
    draft: OrderDraft,
    context: BrokerContext,
  ): Promise<PlaceOrderResult> {
    const preview = await this.previewOrder(draft, context)
    if (!preview.accepted) {
      throw new RequestError(400, preview.reason ?? 'Order with exits rejected by preview')
    }
    if (this.store.getState().connectionStatus !== 'connected') {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }

    const childDrafts = exitChildDrafts(draft)
    const parentOrderId = await this.allocateOrderId()
    const allocatedChildren = []
    for (const child of childDrafts) {
      allocatedChildren.push({ child, orderId: await this.allocateOrderId() })
    }
    const parentId = String(parentOrderId)
    const accountId = context.accountId ?? draft.accountId ?? this.store.getState().activeAccountId
    const submittedAt = new Date().toISOString()
    let parent: Order = {
      ...draft,
      type: draft.type,
      accountId,
      id: parentId,
      brokerOrderId: parentOrderId,
      status: 'placing',
      submittedAt,
      updatedAt: submittedAt,
      remainingQuantity: draft.quantity,
      bracketGroupId: parentId,
    }
    let childOrders = allocatedChildren.map(({ child, orderId }) =>
      toExitChildOrder(
        child.draft,
        draft,
        parent,
        orderId,
        child.leg,
        submittedAt,
        child.paired ? `${parentId}-exit-${child.levelId}` : undefined,
      ),
    )

    const contract = toIbContract(parent.symbol, parent.duration, parent.routingDestination)
    parent = this.ownership?.prepare(parent, contract) ?? parent
    childOrders = childOrders.map((child) => {
      const tagged =
        parent.customFields?.[PAPER_OWNER_FIELD] === undefined
          ? child
          : {
              ...child,
              customFields: {
                ...child.customFields,
                [PAPER_OWNER_FIELD]: parent.customFields[PAPER_OWNER_FIELD],
              },
            }
      return this.ownership?.prepare(tagged, contract) ?? tagged
    })
    this.store.upsertOrder(parent)
    for (const childOrder of childOrders) {
      this.store.upsertOrder(childOrder)
    }

    this.rememberSourceSymbol(contract, parent.symbol)
    const bracketOptions: IbOrderOverrideOptions =
      this.config.ibkrMode === 'paper' ? { overridePercentageConstraints: true } : {}
    this.ib.placeOrder(
      parentOrderId,
      contract,
      toIbOrder(parentOrderId, parent, false, bracketOptions),
    )
    childOrders.forEach((childOrder, index) => {
      const transmit = index === childOrders.length - 1
      this.ib.placeOrder(
        Number(childOrder.brokerOrderId),
        contract,
        toIbOrder(Number(childOrder.brokerOrderId), childOrder, transmit, bracketOptions),
      )
    })
    this.store.addMessage(
      'info',
      `Submitted ${draft.type} ${draft.side} ${draft.quantity} ${draft.symbol.symbol} parent ${parentOrderId} with ${childOrders.length} exit child orders; awaiting IBKR acknowledgement`,
    )
    return { order: parent, preview }
  }

  async modifyOrder(
    orderId: string,
    patch: OrderPatch,
    context: BrokerContext = {},
  ): Promise<PlaceOrderResult> {
    const existing = this.store.getState().orders.find((order) => order.id === orderId)
    if (!existing) {
      throw new RequestError(404, `Order ${orderId} was not found`)
    }
    const ownershipId = existing.customFields?.[PAPER_OWNER_FIELD]
    if (ownershipId !== undefined && patch.customFields !== undefined) {
      if (
        patch.customFields[PAPER_OWNER_FIELD] !== undefined &&
        patch.customFields[PAPER_OWNER_FIELD] !== ownershipId
      )
        throw new RequestError(400, 'An existing paper ownership UUID cannot be changed.')
      patch = {
        ...patch,
        customFields: { ...patch.customFields, [PAPER_OWNER_FIELD]: ownershipId },
      }
    }
    const ownerContext = this.modificationContext(existing, patch, context)
    const draft = applyOrderPatch(existing, patch)
    const preview = await this.previewOrder(draft, ownerContext)
    if (!preview.accepted) {
      throw new RequestError(400, preview.reason ?? 'Modified order rejected by preview')
    }
    const brokerOrderId = Number(existing.brokerOrderId ?? orderId)
    const updated: Order = {
      ...existing,
      ...draft,
      brokerOrderId,
      status: existing.status === 'working' ? 'working' : 'placing',
      updatedAt: new Date().toISOString(),
    }
    const legs = strategyLegsForDraft(updated)
    const target = legs.length
      ? await this.resolveStrategyOrderTarget(legs, updated.side)
      : undefined
    const contract = target
      ? applyOrderRoutingDestination(target.contract, updated.routingDestination, updated.duration)
      : toIbContract(updated.symbol, updated.duration, updated.routingDestination)
    // Broker callbacks and other edits can change the order during preview or contract lookup.
    // Require another preview rather than overwrite the newer broker state.
    if (this.store.getState().orders.find((order) => order.id === orderId) !== existing) {
      throw new RequestError(
        409,
        'Order changed while the modification was being prepared. Retry the modification.',
      )
    }
    this.assertAccountAllowed(existing.accountId)
    this.ownership?.assertModification(updated, contract)
    this.pendingModifications.set(brokerOrderId, existing)
    this.store.upsertOrder(updated)
    this.rememberSourceSymbol(contract, updated.symbol)
    this.ib.placeOrder(
      brokerOrderId,
      contract,
      toIbOrder(
        brokerOrderId,
        updated,
        true,
        this.config.ibkrMode === 'paper' && (target || updated.symbol.assetClass === 'futures')
          ? { overridePercentageConstraints: true }
          : {},
      ),
    )
    this.store.addMessage('info', `Modified order ${orderId}`)
    return { order: updated, preview }
  }

  private modificationContext(
    existing: Order,
    patch: OrderPatch,
    context: BrokerContext,
  ): BrokerContext {
    this.assertAccountAllowed(existing.accountId)
    const unsupported = ibkrOrderModificationRejection(existing)
    if (unsupported) throw new RequestError(400, unsupported)
    if (
      existing.customFields?.ibkrMissingOpenOrder === true ||
      (existing.clientId !== undefined && existing.clientId !== this.config.ibkrClientId) ||
      !Number.isInteger(existing.brokerOrderId ?? Number(existing.id)) ||
      (existing.brokerOrderId ?? Number(existing.id)) === 0
    ) {
      throw new RequestError(
        409,
        'This order is not bound to the current API client. Check its state in TWS before modifying it.',
      )
    }
    if (
      (context.accountId !== undefined && context.accountId !== existing.accountId) ||
      (patch.accountId !== undefined && patch.accountId !== existing.accountId)
    ) {
      throw new RequestError(403, 'Order modifications must use the owning account.')
    }
    if (
      [
        'id',
        'brokerOrderId',
        'brokerOrderRef',
        'permId',
        'clientId',
        'status',
        'submittedAt',
        'updatedAt',
        'filledQuantity',
        'remainingQuantity',
        'avgFillPrice',
      ].some((field) => field in patch) ||
      (patch.symbol !== undefined &&
        JSON.stringify(patch.symbol) !== JSON.stringify(existing.symbol))
    ) {
      throw new RequestError(400, 'Order identity cannot be changed by a modification.')
    }
    return { ...context, accountId: existing.accountId }
  }

  cancelOrder(orderId: string): void {
    const existing = this.store.getState().orders.find((order) => order.id === orderId)
    this.assertAccountAllowed(existing?.accountId ?? this.store.getState().activeAccountId)
    if (
      !existing ||
      existing.customFields?.ibkrMissingOpenOrder === true ||
      (existing.clientId !== undefined && existing.clientId !== this.config.ibkrClientId)
    ) {
      throw new RequestError(409, 'This order is not bound to the current API client.')
    }
    const brokerOrderId = existing.brokerOrderId ?? Number(orderId)
    if (!Number.isInteger(brokerOrderId) || brokerOrderId === 0) {
      throw new RequestError(400, `Invalid order id ${orderId}`)
    }
    if (existing) {
      this.store.upsertOrder({
        ...existing,
        message: 'Cancellation requested. Waiting for IBKR acknowledgement.',
        updatedAt: new Date().toISOString(),
      })
    }
    this.ib.cancelOrder(brokerOrderId)
    this.store.addMessage('info', `Cancel requested for order ${orderId}`)
  }

  async previewClosePosition(
    positionId: string,
    context: BrokerContext = {},
    options: PositionCloseOptions = {},
  ): Promise<OrderPreviewResult> {
    return this.previewOrder(await this.positionCloseDraft(positionId, context, options), context)
  }

  async closePosition(
    positionId: string,
    context: BrokerContext = {},
    options: PositionCloseOptions = {},
  ): Promise<PlaceOrderResult> {
    return this.placeOrder(await this.positionCloseDraft(positionId, context, options), context)
  }

  private async positionCloseDraft(
    positionId: string,
    context: BrokerContext,
    options: PositionCloseOptions,
  ): Promise<OrderDraft> {
    const ownerId = this.validatedOwnershipId(options.paperOwnershipId)
    const position = this.store.getState().positions.find((item) => item.id === positionId)
    if (!position) {
      throw new RequestError(404, `Position ${positionId} was not found`)
    }
    if (context.accountId && context.accountId !== position.accountId)
      throw new RequestError(400, 'The close account must own the selected position.')
    const openQuantity = Math.abs(position.quantity)
    if (openQuantity === 0) {
      throw new RequestError(400, `Position ${positionId} has no open quantity`)
    }
    const quantity = options.quantity ?? openQuantity
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > openQuantity) {
      throw new RequestError(
        400,
        `Close quantity must be greater than zero and no more than the open quantity ${openQuantity}.`,
      )
    }
    const forecast =
      position.symbol.assetClass === 'event-contract' && position.symbol.exchange === 'FORECASTX'
    const closeSymbol = forecast
      ? await opposingForecastContract(this.requests, position.symbol)
      : position.symbol
    const closePrice = forecast ? await this.forecastClosePrice(closeSymbol) : undefined
    const side = forecast ? 'buy' : position.quantity > 0 ? 'sell' : 'buy'
    const option = !forecast ? position.optionContract : undefined
    if (option && !option.underlyingSymbolInfo)
      throw new RequestError(400, 'The option position is missing its typed underlying contract.')
    return {
      accountId: position.accountId,
      symbol: option?.underlyingSymbolInfo ?? closeSymbol,
      side,
      type: forecast ? 'limit' : 'market',
      ...(position.symbol.assetClass === 'stock' ? { routingDestination: 'SMART' } : {}),
      ...(closePrice === undefined ? {} : { limitPrice: closePrice }),
      duration: position.symbol.assetClass === 'crypto' ? 'ioc' : 'day',
      quantity,
      confirmId: options.confirmId,
      ...(ownerId === undefined ? {} : { customFields: { [PAPER_OWNER_FIELD]: ownerId } }),
      ...(option
        ? { optionLegs: [{ contract: option, side, quantity, positionEffect: 'close' }] }
        : {}),
    }
  }

  private async forecastClosePrice(symbol: BrokerSymbol): Promise<number> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const quote = this.quoteForSymbol?.(symbol)
      if (
        quote?.status === 'ok' &&
        positiveContractId(toIbContract(quote.symbol).conId) ===
          positiveContractId(toIbContract(symbol).conId) &&
        positiveContractId(toIbContract(symbol).conId) !== undefined &&
        quote.ask !== undefined &&
        quote.ask >= 0.01 &&
        quote.ask <= 0.99 &&
        Date.now() - Date.parse(quote.timestamp) < 30_000
      )
        return quote.ask
      if (quote?.ibkrErrorCode)
        throw new RequestError(
          503,
          quote.unavailableReason ?? 'Opposing outcome quote is unavailable.',
        )
      if (!this.quoteForSymbol) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new RequestError(
      503,
      'A fresh opposing outcome ask is required to close a ForecastEx position.',
    )
  }

  rejectOrderForRequestError(
    error: Error,
    code?: number,
    requestId?: number,
    suffix = '',
  ): boolean {
    if (requestId == null) return false
    // Negative IDs can identify explicitly bound manual orders. Global notices also
    // use -1, so only an owned pending edit or a specific order error can claim it.
    if (
      requestId < 0 &&
      !this.pendingModifications.has(requestId) &&
      ![104, 105, 110, 161, 201, 202, 404, 10147, 10148, 10149].includes(code ?? 0)
    )
      return false
    const existing = this.findBrokerOrder(requestId, undefined, this.config.ibkrClientId)
    if (!existing) return false
    this.store.addDiagnostic(
      'warning',
      `IBKR raw error orderId=${existing.id} reqId=${requestId} code=${code ?? 'unknown'} message=${error.message}`,
    )
    const updatedAt = new Date().toISOString()
    if (
      existing.status === 'filled' ||
      existing.status === 'rejected' ||
      (existing.status === 'cancelled' &&
        !(code === 202 && parseIbkrPriceControlRejection(error.message)))
    ) {
      this.pendingModifications.delete(requestId)
      this.store.upsertOrder({
        ...existing,
        message: existing.status === 'rejected' ? existing.message : `${error.message}${suffix}`,
        updatedAt,
      })
      return true
    }
    if (code === 10148 || code === 10147 || code === 10149 || code === 161) {
      // A failed cancellation does not reject the underlying order. Reconcile
      // its actual status instead of hiding a pending or filled order.
      this.store.upsertOrder({
        ...existing,
        message: `Cancellation not completed: ${error.message}${suffix}`,
        updatedAt,
      })
      this.ib.reqAllOpenOrders()
      return true
    }
    if (code === 404) {
      // IBKR holds a short sale while locating shares; the broker has not rejected it.
      this.store.upsertOrder({
        ...existing,
        message: `${error.message}${suffix}`,
        updatedAt,
      })
      this.store.addMessage(
        'warning',
        `Order ${existing.id} is held by IBKR: ${error.message}${suffix}`,
      )
      this.ib.reqAllOpenOrders()
      return true
    }
    if (
      code === 105 ||
      (this.pendingModifications.has(requestId) &&
        !isIbOrderWarning(code) &&
        !isNonFatalError(code as ErrorCode, error) &&
        !isIbOrderCancellation(code, error.message))
    ) {
      // A rejected edit leaves the original order working at TWS.
      const original = this.pendingModifications.get(requestId) ?? existing
      this.pendingModifications.delete(requestId)
      this.store.upsertOrder({
        ...original,
        status: existing.status,
        filledQuantity: existing.filledQuantity,
        remainingQuantity: existing.remainingQuantity,
        avgFillPrice: existing.avgFillPrice,
        message: `Modification rejected: ${error.message}${suffix}`,
        updatedAt,
      })
      this.ib.reqAllOpenOrders()
      return true
    }
    if (isIbOrderCancellation(code, error.message)) {
      const message = normalizeIbkrMessage(`${error.message}${suffix}`)
      const priceControl = parseIbkrPriceControlRejection(error.message)
      if (priceControl) {
        this.store.upsertOrder({
          ...existing,
          status: 'rejected',
          message,
          customFields: {
            ...existing.customFields,
            ibkrOrderRejection: {
              kind: 'price-control',
              ...priceControl,
              ...(existing.limitPrice === undefined
                ? {}
                : { submittedLimitPrice: existing.limitPrice }),
            },
          },
          updatedAt,
        })
        this.store.addMessage('error', `Order ${existing.id} rejected by IBKR: ${message}`)
        return true
      }
      this.store.upsertOrder({
        ...existing,
        status: 'cancelled',
        message,
        updatedAt,
      })
      this.store.addMessage(
        'info',
        `Order ${existing.id} cancellation confirmed by IBKR: ${message}`,
      )
      return true
    }
    if (
      isIbOrderWarning(code) ||
      isNonFatalError(code as ErrorCode, error) ||
      (existing.status !== 'placing' && code !== 201)
    ) {
      this.store.upsertOrder({
        ...existing,
        status: existing.status,
        message: `${error.message}${suffix}`,
        updatedAt,
      })
      this.store.addMessage(
        'warning',
        `Order ${existing.id} warning from IBKR: ${error.message}${suffix}`,
      )
      return true
    }
    const message = `${error.message}${suffix}`
    this.store.upsertOrder({
      ...existing,
      status: 'rejected',
      message,
      updatedAt,
    })
    this.store.addMessage(
      'error',
      `Order ${existing.id} rejected by IBKR: ${error.message}${suffix}`,
    )
    return true
  }

  private async allocateOrderId(): Promise<number> {
    const ready = this.orderIds.allocate()
    if (ready !== undefined) return ready
    this.ib.reqIds(1)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new RequestError(503, 'Timed out waiting for IBKR nextValidId'))
      }, 5000)
      const handler = (orderId: number) => {
        cleanup()
        this.orderIds.observeNextValid(orderId)
        const allocated = this.orderIds.allocate()
        if (allocated === undefined)
          reject(new RequestError(503, 'IBKR returned an invalid order ID'))
        else resolve(allocated)
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.ib.off(EventName.nextValidId, handler)
      }
      this.ib.once(EventName.nextValidId, handler)
    })
  }

  private readonly nativeContracts = new Map<number, Contract>()

  private rememberNativeContract(contract: Contract): Contract {
    const id = positiveContractId(contract.conId)
    if (id === undefined) return contract
    // TWS position callbacks omit routing fields. Retain fields from the exact contract's
    // prior resolution/order callback; never derive an exchange from a display symbol.
    const qualified = {
      ...this.nativeContracts.get(id),
      ...Object.fromEntries(
        Object.entries(contract).filter(([, value]) => value !== undefined && value !== ''),
      ),
    }
    this.nativeContracts.set(id, qualified)
    return qualified
  }

  rememberSourceSymbol(contract: Contract, symbol: BrokerSymbol): void {
    contract = this.rememberNativeContract(contract)
    const sourceSymbol = symbol.sourceSymbol
    if (!sourceSymbol) return
    const contractId = positiveContractId(contract.conId)
    if (!sourceIdentityMatchesContract(sourceSymbol, contractId)) return
    if (contractId !== undefined) this.sourceSymbolsByContractId.set(contractId, sourceSymbol)
    const routeKey = brokerContractSourceRouteKey(contract)
    const identities =
      this.sourceSymbolsByRoute.get(routeKey) ?? new Map<string, SourceSymbolIdentity>()
    identities.set(sourceSymbolIdentityKey(sourceSymbol), sourceSymbol)
    this.sourceSymbolsByRoute.set(routeKey, identities)
  }

  symbolFromContract(contract: Contract, preferred?: BrokerSymbol): BrokerSymbol {
    contract = this.rememberNativeContract(contract)
    const nativeSymbol = fromIbSymbol(contract)
    const contractId = positiveContractId(contract.conId)
    const contractIdentity =
      contractId === undefined ? undefined : this.sourceSymbolsByContractId.get(contractId)
    const routeIdentities = this.sourceSymbolsByRoute.get(brokerContractSourceRouteKey(contract))
    const uniqueRouteIdentity =
      routeIdentities?.size === 1 ? routeIdentities.values().next().value : undefined
    const preferredContractId =
      preferred === undefined
        ? undefined
        : positiveContractId(
            preferred.contractIdentity?.conId ?? nativeContractId(preferred.symbol),
          )
    const preferredMatches =
      preferredContractId === undefined ||
      contractId === undefined ||
      preferredContractId === contractId
    const sourceSymbol = [
      contractIdentity,
      preferredMatches ? preferred?.sourceSymbol : undefined,
      uniqueRouteIdentity,
    ].find((source) => source !== undefined && sourceIdentityMatchesContract(source, contractId))
    if (!sourceSymbol) return nativeSymbol
    const resolved = { ...nativeSymbol, sourceSymbol }
    this.rememberSourceSymbol(contract, resolved)
    return resolved
  }

  private validateAccount(accountId: string | undefined): OrderPreviewResult {
    if (!accountId) return { accepted: false, reason: 'An allowlisted account must be selected.' }
    if (!this.config.allowedAccountIds.includes(accountId)) {
      return {
        accepted: false,
        reason: 'The selected account is not authorized for this terminal.',
      }
    }
    return { accepted: true }
  }

  assertAccountAllowed(accountId: string | undefined): void {
    const result = this.validateAccount(accountId)
    if (!result.accepted) throw new RequestError(403, result.reason ?? 'Account is not authorized.')
  }
}

function completedOrderStatus(orderState: OrderState): Order['status'] {
  const completed = String(orderState.completedStatus ?? orderState.status ?? '').toLowerCase()
  if (completed.includes('fill')) return 'filled'
  if (completed.includes('cancel') || completed.includes('expire')) return 'cancelled'
  if (completed.includes('reject')) return 'rejected'
  return 'inactive'
}

function reconciledOrderStatus(
  existing: Order['status'] | undefined,
  incoming: Order['status'],
): Order['status'] {
  if (existing === 'filled') return 'filled'
  if ((existing === 'cancelled' || existing === 'rejected') && incoming !== 'filled')
    return existing
  return incoming
}

function sourceIdentityMatchesContract(
  source: SourceSymbolIdentity,
  contractId: number | undefined,
): boolean {
  return (
    contractId === undefined ||
    [source.canonicalSymbol, source.brokerSymbol].every((symbol) => {
      const id = symbol === undefined ? undefined : nativeContractId(symbol)
      return id === undefined || id === contractId
    })
  )
}
