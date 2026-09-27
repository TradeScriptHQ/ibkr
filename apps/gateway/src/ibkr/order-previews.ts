import type { IBApi, OrderState } from '@stoqey/ib'
import { isIbOrderWarning } from './broker-errors.js'
import type { BridgeConfig } from './config.js'
import { toIbContract } from './contracts.js'
import { commissionEstimate, finiteNumber } from './numbers.js'
import {
  estimateOrderNotional,
  exitChildDrafts,
  hasOptionLegs,
  hasStrategyLegs,
  previewConfirmationId,
  toIbOrder,
} from './orders.js'
import { RequestError } from './request-error.js'
import type { BrokerStateStore } from './state-store.js'
import type { BrokerContext, Order, OrderDraft, OrderPreviewResult } from './types.js'

const ORDER_PREVIEW_TIMEOUT_MS = 8000
/** Owns what-if requests and resolves their commission/margin diagnostics. */
export class OrderPreviews {
  constructor(
    private readonly ib: IBApi,
    private readonly config: BridgeConfig,
    private readonly store: BrokerStateStore,
    private readonly allocateOrderId: () => Promise<number>,
  ) {}
  private readonly pendingWhatIfPreviews = new Map<
    number,
    {
      draft: OrderDraft
      context: BrokerContext
      warnings: string[]
      resolve: (preview: OrderPreviewResult) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()

  readonly whatIfOrderIds = new Set<number>()

  localOrderPreview(
    draft: OrderDraft,
    context: BrokerContext = {},
    warnings: string[] = [],
  ): OrderPreviewResult {
    return {
      accepted: true,
      source: 'local',
      estimatedCost: estimateOrderNotional(draft, context),
      estimatedCostSource: 'local',
      confirmId: previewConfirmationId(),
      warnings: [
        ...warnings,
        ...(context.accountId || draft.accountId
          ? []
          : ['No account selected; IBKR default account will be used if available.']),
        ...(this.config.ibkrMode === 'live' && !this.config.liveOrdersEnabled
          ? [
              'Live order placement is disabled until WIDGET_IBKR_ENABLE_LIVE_ORDERS=I_UNDERSTAND is set.',
            ]
          : []),
      ],
    }
  }

  canUseIbkrWhatIfPreview(draft: OrderDraft): boolean {
    if (this.store.getState().connectionStatus !== 'connected') return false
    if (hasOptionLegs(draft) || hasStrategyLegs(draft)) return false
    return true
  }

  async previewBracketWithIbkrWhatIf(
    draft: OrderDraft,
    context: BrokerContext,
  ): Promise<OrderPreviewResult> {
    // Each leg is a standalone what-if, never a staged or linked executable bracket.
    const entry = await this.previewOrderWithIbkrWhatIf({ ...draft, exits: undefined }, context)
    const exitCommissions: NonNullable<OrderPreviewResult['exitCommissions']> = await Promise.all(
      exitChildDrafts(draft).map(async (child) => {
        const identity = { levelId: child.levelId, leg: child.leg, quantity: child.draft.quantity }
        try {
          const preview = await this.previewOrderWithIbkrWhatIf(child.draft, context)
          return {
            ...identity,
            estimatedCommission: preview.estimatedCommission,
            estimatedCommissionRange: preview.estimatedCommissionRange,
            commissionCurrency: preview.commissionCurrency,
            warnings: preview.warnings,
            reason:
              preview.estimatedCommission === undefined &&
              preview.estimatedCommissionRange === undefined
                ? 'IBKR did not return a commission estimate.'
                : undefined,
          }
        } catch (error) {
          return { ...identity, reason: error instanceof Error ? error.message : String(error) }
        }
      }),
    )
    return {
      ...entry,
      exitCommissions,
      warnings: [
        ...(entry.warnings ?? []),
        ...exitCommissions.flatMap((exit) => {
          const label = `${exit.leg === 'take-profit' ? 'Take profit' : 'Stop loss'} (${exit.quantity})`
          return [
            ...(exit.reason ? [`${label} commission unavailable: ${exit.reason}`] : []),
            ...(exit.warnings ?? []).map((warning) => `${label} estimate: ${warning}`),
          ]
        }),
      ],
    }
  }

  async previewOrderWithIbkrWhatIf(
    draft: OrderDraft,
    context: BrokerContext,
  ): Promise<OrderPreviewResult> {
    const orderId = await this.allocateOrderId()
    const accountId = context.accountId ?? draft.accountId ?? this.store.getState().activeAccountId
    // A new what-if order must not refer to an existing bracket/OCA group. In particular,
    // an exit's parent may already be filled and no longer accept new attached orders.
    const previewDraft: OrderDraft = {
      ...draft,
      accountId,
      parentId: undefined,
      parentType: undefined,
      bracketGroupId: undefined,
      ocaGroup: undefined,
      ocaType: undefined,
    }
    this.whatIfOrderIds.add(orderId)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const pending = this.pendingWhatIfPreviews.get(orderId)
        if (pending) clearTimeout(pending.timeout)
        this.pendingWhatIfPreviews.delete(orderId)
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new RequestError(504, 'Timed out waiting for IBKR order preview'))
      }, ORDER_PREVIEW_TIMEOUT_MS)
      this.pendingWhatIfPreviews.set(orderId, {
        draft: previewDraft,
        context,
        warnings: [],
        timeout,
        resolve: (preview) => {
          cleanup()
          resolve(preview)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      })
      this.ib.placeOrder(
        orderId,
        toIbContract(previewDraft.symbol, previewDraft.duration, previewDraft.routingDestination),
        toIbOrder(orderId, previewDraft as Order, true, { whatIf: true }),
      )
    })
  }

  resolveWhatIfPreview(orderId: number, orderState: OrderState): boolean {
    const pending = this.pendingWhatIfPreviews.get(orderId)
    if (!pending) return false
    const warning = String(orderState.warningText ?? '').trim()
    const warnings = [...pending.warnings, ...(warning ? [warning] : [])]
    const estimatedCommission = commissionEstimate(orderState.commission)
    const minimumCommission = commissionEstimate(orderState.minCommission)
    const maximumCommission = commissionEstimate(orderState.maxCommission)
    const estimatedCommissionRange =
      estimatedCommission === undefined &&
      (minimumCommission !== undefined || maximumCommission !== undefined)
        ? {
            ...(minimumCommission === undefined ? {} : { minimum: minimumCommission }),
            ...(maximumCommission === undefined ? {} : { maximum: maximumCommission }),
          }
        : undefined
    pending.resolve({
      accepted: true,
      source: 'broker',
      estimatedCost: estimateOrderNotional(pending.draft, pending.context),
      estimatedCostSource: 'local',
      estimatedCostCurrency: pending.draft.symbol.currency,
      estimatedCommission,
      estimatedCommissionRange,
      commissionCurrency: orderState.commissionCurrency?.trim() || undefined,
      estimatedMargin:
        finiteNumber(orderState.initMarginChange) ?? finiteNumber(orderState.maintMarginChange),
      marginCurrency: this.store
        .getState()
        .accounts.find((account) => account.id === pending.draft.accountId)?.currency,
      confirmId: previewConfirmationId(),
      warnings: warnings.length ? warnings : undefined,
    })
    this.store.addDiagnostic(
      'info',
      `IBKR what-if preview orderId=${orderId} commission=${String(orderState.commission ?? '-')} minCommission=${String(orderState.minCommission ?? '-')} maxCommission=${String(orderState.maxCommission ?? '-')}`,
    )
    return true
  }

  rejectWhatIfPreviewError(error: Error, code?: number, requestId?: number, suffix = ''): boolean {
    if (requestId == null) return false
    const pending = this.pendingWhatIfPreviews.get(requestId)
    if (!pending) return false
    if (isIbOrderWarning(code)) {
      pending.warnings.push(`${error.message}${suffix}`)
      return true
    }
    pending.reject(new RequestError(400, `${error.message}${suffix}`))
    return true
  }
}
