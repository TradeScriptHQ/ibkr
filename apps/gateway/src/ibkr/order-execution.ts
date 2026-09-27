import type {
  ComboLeg,
  Contract,
  Execution as IbExecution,
  Order as IbOrder,
  OrderState,
} from '@stoqey/ib'
import { EventName, type IBApi, OrderAction, SecType } from '@stoqey/ib'
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
  sourceSymbolIdentityKey,
  toIbContract,
  toIbOptionContract,
} from './contracts.js'
import { opposingForecastContract } from './forecast-contracts.js'
import type { IbkrRequests } from './ibkr-requests.js'
import { positiveContractId } from './numbers.js'
import { optionContractWithSourceIdentity } from './option-chain.js'
import { OrderPreviews } from './order-previews.js'
import type { IbOrderOverrideOptions } from './orders.js'
import {
  applyOrderPatch,
  describeOptionLeg,
  exitChildDrafts,
  fromIbExecution,
  fromIbOpenOrder,
  hasOptionLegs,
  hasStrategyLegs,
  mapOrderStatus,
  strategyLegsForDraft,
  strategyOrderNetSide,
  strategyOrderQuantity,
  toExitChildOrder,
  toIbOrder,
  validateDraft,
} from './orders.js'
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
  PlaceOrderResult,
  PositionCloseOptions,
  SourceSymbolIdentity,
  StrategyOrderLegDraft,
} from './types.js'

const ORDER_CANCELLATION_REASON_WAIT_MS = 250
/** Owns order submission, broker acknowledgement and execution reconciliation. */
export class OrderExecution {
  private readonly pendingModifications = new Map<number, Order>()
  readonly previews: OrderPreviews
  constructor(
    private readonly ib: IBApi,
    private readonly config: BridgeConfig,
    private readonly store: BrokerStateStore,
    private readonly requests: Pick<IbkrRequests, 'requestContractDetails'>,
    private readonly quoteForSymbol?: (symbol: BrokerSymbol) => MarketQuote | undefined,
    private readonly orderIds = new OrderIdAllocator(),
  ) {
    this.previews = new OrderPreviews(this.ib, this.config, this.store, () =>
      this.allocateOrderId(),
    )
    this.registerHandlers()
  }
  private registerHandlers(): void {
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
        const state = this.store.getState()
        const existing =
          state.orders.find((item) => item.id === String(orderId)) ??
          state.ordersHistory?.find((item) => item.id === String(orderId))
        this.pendingModifications.delete(orderId)
        const incoming = fromIbOpenOrder(orderId, contract, order, orderState)
        const reconciledSymbol = this.symbolFromContract(contract, existing?.symbol)
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
          trailingStopPips: incoming.trailingStopPips ?? existing?.trailingStopPips,
          exits: incoming.exits ?? existing?.exits,
          exitLevelId: incoming.exitLevelId ?? existing?.exitLevelId,
          takeProfitOutsideRth: incoming.takeProfitOutsideRth ?? existing?.takeProfitOutsideRth,
          confirmId: incoming.confirmId ?? existing?.confirmId,
          customFields: {
            ...existing?.customFields,
            ...incoming.customFields,
          },
          message: incoming.message ?? existing?.message,
          submittedAt: existing?.submittedAt ?? incoming.submittedAt,
        })
      },
    )
    this.ib.on(
      EventName.completedOrder,
      (contract: Contract, ibOrder: IbOrder, orderState: OrderState) => {
        const orderId = Number(ibOrder.orderId)
        if (!Number.isFinite(orderId)) {
          this.store.addDiagnostic(
            'warning',
            `IBKR completedOrder omitted its API order id for ${String(contract.symbol ?? '') || 'unknown'}`,
          )
          return
        }
        this.orderIds.observeUsed(orderId)
        const state = this.store.getState()
        const existing =
          state.orders.find((order) => order.id === String(orderId)) ??
          state.ordersHistory?.find((order) => order.id === String(orderId))
        const incoming = fromIbOpenOrder(orderId, contract, ibOrder, orderState)
        const status = completedOrderStatus(orderState)
        const quantity = incoming.quantity > 0 ? incoming.quantity : (existing?.quantity ?? 0)
        const filledQuantity =
          status === 'filled'
            ? Math.max(existing?.filledQuantity ?? 0, quantity)
            : existing?.filledQuantity
        this.store.upsertOrder({
          ...incoming,
          status,
          symbol: this.symbolFromContract(contract, existing?.symbol),
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
          trailingStopPips: incoming.trailingStopPips ?? existing?.trailingStopPips,
          exits: incoming.exits ?? existing?.exits,
          exitLevelId: incoming.exitLevelId ?? existing?.exitLevelId,
          takeProfitOutsideRth: incoming.takeProfitOutsideRth ?? existing?.takeProfitOutsideRth,
          confirmId: incoming.confirmId ?? existing?.confirmId,
          customFields: {
            ...existing?.customFields,
            ...incoming.customFields,
            ibkrCompleted: true,
            ibkrCompletedStatus: orderState.completedStatus ?? orderState.status,
          },
          message: incoming.message,
          submittedAt: existing?.submittedAt ?? incoming.submittedAt,
          updatedAt: new Date().toISOString(),
        })
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
      ) => {
        this.orderIds.observeUsed(orderId)
        if (this.previews.whatIfOrderIds.has(orderId)) return
        this.store.addDiagnostic(
          'info',
          `IBKR raw orderStatus orderId=${orderId} status=${status} filled=${filled} remaining=${remaining} avgFillPrice=${avgFillPrice}`,
        )
        const state = this.store.getState()
        const existing =
          state.orders.find((order) => order.id === String(orderId)) ??
          state.ordersHistory?.find((order) => order.id === String(orderId))
        if (!existing) return
        const mappedStatus = mapOrderStatus(status)
        const previousStatus = existing.status
        const normalizedAvgFillPrice =
          Number.isFinite(avgFillPrice) && avgFillPrice > 0
            ? avgFillPrice
            : existing.avgFillPrice !== undefined && existing.avgFillPrice > 0
              ? existing.avgFillPrice
              : undefined
        this.store.upsertOrder({
          ...existing,
          status: mappedStatus,
          message:
            mappedStatus === 'cancelled' || mappedStatus === 'filled'
              ? undefined
              : existing.message,
          filledQuantity: filled,
          remainingQuantity: remaining,
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
        const order = this.orderForExecution(execution)
        const accountId = execution.acctNumber ?? order?.accountId
        const incoming = fromIbExecution(contract, execution, accountId)
        const symbol = this.symbolFromContract(contract, order?.symbol)
        const reconciledExecution = {
          ...incoming,
          symbol,
          optionContract: optionContractWithSourceIdentity(incoming.optionContract, symbol),
        }
        const retained = this.store.upsertExecution(reconciledExecution)
        if (order && retained) this.reconcileOrderFromExecution(order, contract, execution)
      },
    )
  }

  private orderForExecution(execution: IbExecution): Order | undefined {
    if (execution.orderId == null) return undefined
    const orderId = String(execution.orderId)
    const accountId = String(execution.acctNumber ?? '')
    const state = this.store.getState()
    return [...state.orders, ...(state.ordersHistory ?? [])].find((order) => {
      const identityMatches =
        order.id === orderId ||
        (order.brokerOrderId !== undefined && order.brokerOrderId === execution.orderId)
      const accountMatches = !accountId || !order.accountId || order.accountId === accountId
      return identityMatches && accountMatches
    })
  }

  private reconcileOrderFromExecution(order: Order, contract: Contract, raw: IbExecution): void {
    const multiLeg = (order.optionLegs?.length ?? 0) > 1 || (order.strategyLegs?.length ?? 0) > 1
    if (multiLeg && String(contract.secType ?? '').toUpperCase() !== SecType.BAG) return
    const cumulativeQuantity = Number(raw.cumQty)
    const hasCumulativeQuantity = Number.isFinite(cumulativeQuantity) && cumulativeQuantity >= 0
    // Parent combo quantity cannot be reconstructed by summing its individual leg executions.
    if (multiLeg && !hasCumulativeQuantity) return

    const submittedAt = Date.parse(order.submittedAt)
    const related = this.store.getState().executions.filter((candidate) => {
      const orderMatches =
        candidate.orderId === order.id || candidate.orderId === String(order.brokerOrderId)
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
      Number.isFinite(reportedAverage) && reportedAverage > 0
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
      updatedAt: new Date().toISOString(),
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

  async previewModifyOrder(
    orderId: string,
    patch: OrderPatch,
    context: BrokerContext = {},
  ): Promise<OrderPreviewResult> {
    const existing = this.store.getState().orders.find((order) => order.id === orderId)
    if (!existing) throw new RequestError(404, `Order ${orderId} was not found`)
    return this.previewOrder(applyOrderPatch(existing, patch), context)
  }

  async placeOrder(draft: OrderDraft, context: BrokerContext = {}): Promise<PlaceOrderResult> {
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
    this.assertOrderMutationAllowed()

    const orderId = await this.allocateOrderId()
    const submittedAt = new Date().toISOString()
    const order: Order = {
      ...draft,
      accountId: context.accountId ?? draft.accountId ?? this.store.getState().activeAccountId,
      id: String(orderId),
      brokerOrderId: orderId,
      status: 'placing',
      submittedAt,
      updatedAt: submittedAt,
      remainingQuantity: draft.quantity,
    }
    this.store.upsertOrder(order)

    const contract = toIbContract(draft.symbol, draft.duration, draft.routingDestination)
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
    this.assertOrderMutationAllowed()

    const strategyTarget = await this.resolveStrategyOrderTarget(strategyLegsForDraft(draft))
    const orderId = await this.allocateOrderId()
    const submittedAt = new Date().toISOString()
    const order: Order = {
      ...draft,
      accountId: context.accountId ?? draft.accountId ?? this.store.getState().activeAccountId,
      side: strategyTarget.side,
      quantity: strategyTarget.quantity,
      id: String(orderId),
      brokerOrderId: orderId,
      status: 'placing',
      submittedAt,
      updatedAt: submittedAt,
      remainingQuantity: strategyTarget.quantity,
    }
    this.store.upsertOrder(order)

    const routedContract = applyOrderRoutingDestination(
      strategyTarget.contract,
      draft.routingDestination,
      draft.duration,
    )
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

  private async resolveStrategyOrderTarget(strategyLegs: StrategyOrderLegDraft[]): Promise<{
    contract: Contract
    side: Order['side']
    quantity: number
    description: string
  }> {
    if (!strategyLegs.length)
      throw new RequestError(400, 'Strategy order requires at least one leg.')
    const resolved = await Promise.all(
      strategyLegs.map(async (source) => {
        if (source.instrument === 'option') {
          const option = await this.resolveOptionLeg(source)
          return { source, contract: option.contract }
        }
        const query = toIbContract(source.symbolInfo)
        const details = await this.requests.requestContractDetails(query)
        const match = details.find((item) => item.contract?.conId != null)
        if (!match?.contract?.conId)
          throw new RequestError(404, `IBKR stock contract was not found for ${source.symbol}.`)
        const resolvedContract = { ...query, ...match.contract, conId: match.contract.conId }
        this.rememberSourceSymbol(resolvedContract, source.symbolInfo)
        return { source, contract: resolvedContract }
      }),
    )
    const firstResolved = resolved[0]
    if (resolved.length === 1 && firstResolved?.source.instrument === 'option') {
      return {
        contract: firstResolved.contract,
        side: firstResolved.source.side,
        quantity: firstResolved.source.quantity,
        description: `option ${describeOptionLeg(firstResolved.source)}`,
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
    const side = strategyOrderNetSide(strategyLegs)
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
    }
  }

  private async resolveOptionLeg(
    leg: OptionOrderLegDraft,
  ): Promise<{ source: OptionOrderLegDraft; contract: Contract & { conId: number } }> {
    const query = toIbOptionContract(leg.contract)
    const details = await this.requests.requestContractDetails(query)
    const match = details.find((item) => item.contract?.conId != null)
    if (!match?.contract?.conId) {
      throw new RequestError(404, `IBKR contract was not found for ${describeOptionLeg(leg)}`)
    }
    return {
      source: leg,
      contract: {
        ...query,
        ...match.contract,
        conId: match.contract.conId,
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
    this.assertOrderMutationAllowed()

    const childDrafts = exitChildDrafts(draft)
    const parentOrderId = await this.allocateOrderId()
    const allocatedChildren = []
    for (const child of childDrafts) {
      allocatedChildren.push({ child, orderId: await this.allocateOrderId() })
    }
    const parentId = String(parentOrderId)
    const accountId = context.accountId ?? draft.accountId ?? this.store.getState().activeAccountId
    const submittedAt = new Date().toISOString()
    const parent: Order = {
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
    const childOrders = allocatedChildren.map(({ child, orderId }) =>
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

    this.store.upsertOrder(parent)
    for (const childOrder of childOrders) {
      this.store.upsertOrder(childOrder)
    }

    const contract = toIbContract(parent.symbol, parent.duration, parent.routingDestination)
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
    const draft = applyOrderPatch(existing, patch)
    const preview = await this.previewOrder(draft, context)
    if (!preview.accepted) {
      throw new RequestError(400, preview.reason ?? 'Modified order rejected by preview')
    }
    this.assertOrderMutationAllowed()
    const brokerOrderId = Number(existing.brokerOrderId ?? orderId)
    const updatedAt = new Date().toISOString()
    const updated: Order = {
      ...existing,
      ...draft,
      brokerOrderId,
      status: existing.status === 'working' ? 'working' : 'placing',
      updatedAt,
    }
    const legs = strategyLegsForDraft(updated)
    const target = legs.length ? await this.resolveStrategyOrderTarget(legs) : undefined
    const contract = target
      ? applyOrderRoutingDestination(target.contract, updated.routingDestination, updated.duration)
      : toIbContract(updated.symbol, updated.duration, updated.routingDestination)
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

  cancelOrder(orderId: string): void {
    const existing = this.store.getState().orders.find((order) => order.id === orderId)
    this.assertAccountAllowed(existing?.accountId ?? this.store.getState().activeAccountId)
    this.assertOrderMutationAllowed()
    const brokerOrderId = Number(orderId)
    if (!Number.isFinite(brokerOrderId)) {
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
      ...(closePrice === undefined ? {} : { limitPrice: closePrice }),
      duration: position.symbol.assetClass === 'crypto' ? 'ioc' : 'day',
      quantity,
      confirmId: options.confirmId,
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
    const state = this.store.getState()
    const existing = [...state.orders, ...(state.ordersHistory ?? [])].find((order) => {
      return order.id === String(requestId) || order.brokerOrderId === requestId
    })
    if (!existing) return false
    this.store.addDiagnostic(
      'warning',
      `IBKR raw error orderId=${existing.id} reqId=${requestId} code=${code ?? 'unknown'} message=${error.message}`,
    )
    const updatedAt = new Date().toISOString()
    if (code === 10148) {
      // A failed cancellation does not reject the underlying order. Reconcile
      // its actual status instead of hiding a pending or filled order.
      this.store.upsertOrder({
        ...existing,
        message: `Cancellation not completed: ${error.message}${suffix}`,
        updatedAt,
      })
      this.ib.reqOpenOrders()
      return true
    }
    if (code === 105) {
      // A rejected edit leaves the original order working at TWS.
      const original = this.pendingModifications.get(requestId) ?? existing
      this.pendingModifications.delete(requestId)
      this.store.upsertOrder({
        ...original,
        message: `Modification rejected: ${error.message}${suffix}`,
        updatedAt,
      })
      this.ib.reqOpenOrders()
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
    if (isIbOrderWarning(code)) {
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
    const message =
      existing.status === 'rejected' && existing.message
        ? existing.message
        : `${error.message}${suffix}`
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
    const sourceSymbol = preferred?.sourceSymbol ?? contractIdentity ?? uniqueRouteIdentity
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

  private assertOrderMutationAllowed(): void {
    if (
      !(
        this.config.tradingEnabled ??
        (this.config.ibkrMode === 'paper' || this.config.liveOrdersEnabled)
      )
    ) {
      throw new RequestError(
        403,
        'This connection is read-only. Enable trading in Connection settings.',
      )
    }
  }
}

function completedOrderStatus(orderState: OrderState): Order['status'] {
  const completed = String(orderState.completedStatus ?? orderState.status ?? '').toLowerCase()
  if (completed.includes('fill')) return 'filled'
  if (completed.includes('cancel') || completed.includes('expire')) return 'cancelled'
  if (completed.includes('reject')) return 'rejected'
  return 'inactive'
}
