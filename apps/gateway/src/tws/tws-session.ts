import { randomUUID } from 'node:crypto'
import {
  type Contract,
  type ErrorCode,
  EventName,
  IBApi,
  type Order,
  type OrderState,
} from '@stoqey/ib'
import type { GatewayConfig } from '../config.js'
import { OrderIdAllocator } from './order-id-allocator.js'

export type TwsConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'reconciling'
  | 'ready'
  | 'degraded'
  | 'error'

export interface TwsSessionSnapshot {
  readonly generation: string
  readonly state: TwsConnectionState
  readonly message: string
  readonly socketConnected: boolean
  readonly nextValidOrderIdReady: boolean
  readonly reconciliationComplete: boolean
  readonly managedAccountIds: readonly string[]
  readonly allowedAccountIds: readonly string[]
  readonly matchedAccountIds: readonly string[]
  readonly openOrderCount: number
  readonly completedOrderCount: number
  readonly positionCount: number
  readonly executionCount: number
  readonly lastErrorCode?: number
}

interface ReconciliationProgress {
  accountSummary: boolean
  positions: boolean
  openOrders: boolean
  completedOrders: boolean
  executions: boolean
}

type Subscriber = (snapshot: TwsSessionSnapshot) => void

const RECONCILIATION_TIMEOUT_MS = 30_000
const MAX_RECONNECT_DELAY_MS = 30_000

export class TwsSession {
  readonly #config: GatewayConfig['ibkr']
  readonly #api: IBApi
  readonly #subscribers = new Set<Subscriber>()
  readonly #accountSummaryRequestId = 900_001
  readonly #executionRequestId = 900_002
  #desiredConnection = false
  #generation = randomUUID()
  #initializedGeneration: string | undefined
  #state: TwsConnectionState = 'disconnected'
  #message = 'TWS is not connected.'
  #socketConnected = false
  #nextOrderIdReady = false
  #managedAccountIds: readonly string[] = []
  #progress: ReconciliationProgress = this.#emptyProgress()
  #openOrderPhase: 'owned' | 'all' | 'complete' = 'complete'
  #openOrders = new Set<string>()
  #completedOrders = new Set<string>()
  #positions = new Set<string>()
  #executions = new Set<string>()
  #lastErrorCode: number | undefined
  #reconnectAttempt = 0
  #reconnectTimer: NodeJS.Timeout | undefined
  #reconciliationTimer: NodeJS.Timeout | undefined

  constructor(
    config: GatewayConfig['ibkr'],
    api?: IBApi,
    private readonly orderIds = new OrderIdAllocator(),
  ) {
    this.#config = config
    this.#api = api ?? new IBApi({ host: config.host, port: config.port, maxReqPerSec: 40 })
    this.#registerListeners()
  }

  snapshot(): TwsSessionSnapshot {
    const allowed = new Set(this.#config.allowedAccountIds)
    const matchedAccountIds = this.#managedAccountIds.filter((accountId) => allowed.has(accountId))
    return {
      generation: this.#generation,
      state: this.#state,
      message: this.#message,
      socketConnected: this.#socketConnected,
      nextValidOrderIdReady: this.#nextOrderIdReady,
      reconciliationComplete: this.#isReconciliationComplete(),
      managedAccountIds: this.#managedAccountIds,
      allowedAccountIds: this.#config.allowedAccountIds,
      matchedAccountIds,
      openOrderCount: this.#openOrders.size,
      completedOrderCount: this.#completedOrders.size,
      positionCount: this.#positions.size,
      executionCount: this.#executions.size,
      ...(this.#lastErrorCode === undefined ? {} : { lastErrorCode: this.#lastErrorCode }),
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber)
    subscriber(this.snapshot())
    return () => this.#subscribers.delete(subscriber)
  }

  connect(): void {
    this.#desiredConnection = true
    if (this.#socketConnected || this.#state === 'connecting') return
    this.#clearReconnectTimer()
    this.#transition(
      'connecting',
      `Connecting to the local TWS ${this.#config.executionEnvironment} session.`,
    )
    this.#api.connect(this.#config.clientId)
  }

  disconnect(): void {
    this.#desiredConnection = false
    this.#clearReconnectTimer()
    this.#clearReconciliationTimer()
    this.#invalidateBrokerReadiness()
    if (this.#api.isConnected) this.#api.disconnect()
    this.#transition('disconnected', 'TWS was disconnected by the local operator.')
  }

  allocateOrderId(): number {
    if (this.#state !== 'ready' || !this.#nextOrderIdReady) {
      throw new Error('TWS order allocation is unavailable until reconciliation is complete')
    }
    const allocated = this.orderIds.allocate()
    if (allocated === undefined) throw new Error('TWS has not supplied a valid order ID')
    return allocated
  }

  #registerListeners(): void {
    this.#api
      .on(EventName.connected, () => {
        this.#socketConnected = true
        this.#reconnectAttempt = 0
        this.#transition('connecting', 'TWS socket connected; waiting for protocol readiness.')
      })
      .on(EventName.disconnected, () => this.#handleDisconnected())
      .on(
        EventName.error,
        (error: Error, code: ErrorCode, requestId: number, _advancedOrderReject?: unknown) => {
          this.#handleError(error, Number(code), requestId)
        },
      )
      .on(EventName.managedAccounts, (accountsCsv: string) => {
        this.#managedAccountIds = [
          ...new Set(
            accountsCsv
              .split(',')
              .map((accountId) => accountId.trim())
              .filter(Boolean),
          ),
        ]
        this.#notify()
        this.#maybeReady()
      })
      .on(EventName.nextValidId, (orderId: number) => {
        this.#receiveNextValidOrderId(orderId)
        if (this.#initializedGeneration !== this.#generation) {
          this.#initializedGeneration = this.#generation
          this.#beginReconciliation()
        }
      })
      .on(
        EventName.accountSummary,
        (requestId: number, _account: string, _tag: string, _value: string, _currency: string) => {
          if (requestId !== this.#accountSummaryRequestId) return
        },
      )
      .on(EventName.accountSummaryEnd, (requestId: number) => {
        if (requestId !== this.#accountSummaryRequestId) return
        this.#progress.accountSummary = true
        this.#maybeReady()
      })
      .on(EventName.position, (account: string, contract: Contract, position: number) => {
        const key = `${account}:${contract.conId ?? contract.localSymbol ?? contract.symbol ?? 'unknown'}`
        if (position === 0) this.#positions.delete(key)
        else this.#positions.add(key)
      })
      .on(EventName.positionEnd, () => {
        this.#progress.positions = true
        this.#maybeReady()
      })
      .on(
        EventName.openOrder,
        (orderId: number, _contract: Contract, order: Order, _orderState: OrderState) => {
          this.#raiseOrderIdHighWatermark(orderId)
          const permId = order.permId
          const key =
            typeof permId === 'number' && permId > 0
              ? `perm:${permId}`
              : `api:${order.clientId ?? this.#config.clientId}:${orderId}`
          this.#openOrders.add(key)
        },
      )
      .on(EventName.orderStatus, (orderId: number) => this.#raiseOrderIdHighWatermark(orderId))
      .on(EventName.openOrderEnd, () => this.#handleOpenOrderEnd())
      .on(EventName.completedOrder, (_contract: Contract, order: Order) => {
        const key =
          typeof order.permId === 'number' && order.permId > 0
            ? `perm:${order.permId}`
            : `completed:${order.clientId ?? 'unknown'}:${order.orderId ?? 'unknown'}`
        this.#completedOrders.add(key)
      })
      .on(EventName.completedOrdersEnd, () => {
        this.#progress.completedOrders = true
        this.#maybeReady()
      })
      .on(EventName.execDetails, (requestId: number, _contract: Contract, execution) => {
        if (requestId !== this.#executionRequestId && requestId !== -1) return
        if (execution.execId !== undefined) this.#executions.add(execution.execId)
      })
      .on(EventName.execDetailsEnd, (requestId: number) => {
        if (requestId !== this.#executionRequestId) return
        this.#progress.executions = true
        this.#maybeReady()
      })
  }

  #beginReconciliation(): void {
    this.#progress = this.#emptyProgress()
    this.#openOrders.clear()
    this.#completedOrders.clear()
    this.#positions.clear()
    this.#executions.clear()
    this.#transition('reconciling', 'TWS protocol is ready; reconciling broker state.')

    this.#api.reqManagedAccts()
    this.#api.reqAccountSummary(
      this.#accountSummaryRequestId,
      'All',
      [
        'NetLiquidation',
        'TotalCashValue',
        'BuyingPower',
        'AvailableFunds',
        'InitMarginReq',
        'MaintMarginReq',
        'ExcessLiquidity',
        'GrossPositionValue',
        'RealizedPnL',
        'UnrealizedPnL',
      ].join(','),
    )
    this.#api.reqPositions()

    if (this.#config.bindManualOrders) {
      this.#openOrderPhase = 'owned'
      this.#api.reqAutoOpenOrders(true)
      this.#api.reqOpenOrders()
    } else {
      this.#openOrderPhase = 'all'
      this.#api.reqAllOpenOrders()
    }

    this.#api.reqCompletedOrders(false)
    this.#api.reqExecutions(this.#executionRequestId, {})
    this.#clearReconciliationTimer()
    this.#reconciliationTimer = setTimeout(() => {
      if (!this.#isReconciliationComplete()) {
        this.#transition('error', 'TWS reconciliation timed out; trading remains disabled.')
      }
    }, RECONCILIATION_TIMEOUT_MS)
  }

  #handleOpenOrderEnd(): void {
    if (this.#openOrderPhase === 'owned') {
      this.#openOrderPhase = 'all'
      this.#api.reqAllOpenOrders()
      return
    }
    if (this.#openOrderPhase === 'all') {
      this.#openOrderPhase = 'complete'
      this.#progress.openOrders = true
      this.#maybeReady()
    }
  }

  #handleDisconnected(): void {
    this.#socketConnected = false
    this.#generation = randomUUID()
    this.#initializedGeneration = undefined
    this.#invalidateBrokerReadiness()
    this.#transition('disconnected', 'The TWS socket is disconnected; broker state is stale.')
    if (this.#desiredConnection) this.#scheduleReconnect()
  }

  #handleError(error: Error, code: number, requestId: number): void {
    this.#lastErrorCode = code
    if (code === 1100) {
      this.#transition('degraded', 'IBKR connectivity was lost; trading is frozen.')
      return
    }
    if (code === 1101 || code === 1102) {
      this.#initializedGeneration = undefined
      this.#invalidateBrokerReadiness()
      this.#transition('reconciling', 'IBKR connectivity returned; broker state is reconciling.')
      this.#api.reqIds()
      return
    }
    if (code === 326) {
      this.#desiredConnection = false
      this.#transition('error', 'TWS API client ID 0 is already in use.')
      return
    }
    if (code === 502 || code === 504) {
      this.#transition('error', 'Unable to connect to TWS on the configured port.')
      return
    }
    if (requestId >= 0) {
      // Request-scoped errors are surfaced by the owning IBKR operation. They must not
      // replace the session readiness message or make a healthy connection look stale.
      return
    }
    this.#message = `TWS reported code ${code}: ${error.message}`
    this.#notify()
  }

  #raiseOrderIdHighWatermark(orderId: number): void {
    if (!Number.isInteger(orderId) || orderId < 0) return
    this.orderIds.observeUsed(orderId)
    this.#notify()
  }

  #receiveNextValidOrderId(orderId: number): void {
    if (!Number.isInteger(orderId) || orderId < 0) return
    this.orderIds.observeNextValid(orderId)
    this.#nextOrderIdReady = true
    this.#notify()
  }

  #maybeReady(): void {
    if (!this.#isReconciliationComplete()) return
    this.#clearReconciliationTimer()
    if (this.#managedAccountIds.length === 0) {
      this.#transition('error', 'TWS returned no managed accounts; trading remains disabled.')
      return
    }
    this.#transition('ready', 'TWS account state is reconciled.')
  }

  #isReconciliationComplete(): boolean {
    return (
      this.#nextOrderIdReady &&
      this.#progress.accountSummary &&
      this.#progress.positions &&
      this.#progress.openOrders &&
      this.#progress.completedOrders &&
      this.#progress.executions
    )
  }

  #invalidateBrokerReadiness(): void {
    this.#nextOrderIdReady = false
    this.#progress = this.#emptyProgress()
    this.#openOrderPhase = 'complete'
    this.#clearReconciliationTimer()
  }

  #emptyProgress(): ReconciliationProgress {
    return {
      accountSummary: false,
      positions: false,
      openOrders: false,
      completedOrders: false,
      executions: false,
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined) return
    const baseDelay = Math.min(1_000 * 2 ** this.#reconnectAttempt, MAX_RECONNECT_DELAY_MS)
    const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5))
    this.#reconnectAttempt += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      if (this.#desiredConnection) this.connect()
    }, delay)
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) return
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
  }

  #clearReconciliationTimer(): void {
    if (this.#reconciliationTimer === undefined) return
    clearTimeout(this.#reconciliationTimer)
    this.#reconciliationTimer = undefined
  }

  #transition(state: TwsConnectionState, message: string): void {
    this.#state = state
    this.#message = message
    this.#notify()
  }

  #notify(): void {
    const snapshot = this.snapshot()
    for (const subscriber of this.#subscribers) subscriber(snapshot)
  }
}
