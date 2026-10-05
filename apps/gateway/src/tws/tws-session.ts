import { randomUUID } from 'node:crypto'
import {
  type BrokerConnectionDiagnostics,
  type ConnectionType,
  connectionTypeLabel,
  inferConnectionType,
} from '@ibkr-terminal/contracts'
import {
  type Contract,
  type ErrorCode,
  EventName,
  IBApi,
  type Order,
  type OrderState,
} from '@stoqey/ib'
import type { GatewayConfig } from '../config.js'
import { accountsMatchExecutionEnvironment } from '../connections/account-environment.js'
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
  readonly connection: BrokerConnectionDiagnostics
}

interface ReconciliationProgress {
  accountSummary: boolean
  positions: boolean
  openOrders: boolean
  completedOrders: boolean
  executions: boolean
}

type Subscriber = (snapshot: TwsSessionSnapshot) => void

const API_STARTUP_TIMEOUT_MS = 5_000
const RECONCILIATION_TIMEOUT_MS = 30_000
const MAX_AUTOMATIC_RETRIES = 5

export class TwsSession {
  readonly #config: GatewayConfig['ibkr']
  readonly #connectionLabel: string
  readonly #connectionType: ConnectionType
  readonly #api: IBApi
  readonly #subscribers = new Set<Subscriber>()
  #accountSummaryRequestId: number | undefined
  #executionRequestId: number | undefined
  #desiredConnection = false
  #generation = randomUUID()
  #initializedGeneration: string | undefined
  #state: TwsConnectionState = 'disconnected'
  #message: string
  #socketConnected = false
  #connectivityLost = false
  #reconnectMessage: string | undefined
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
  #reconnectExhausted = false
  #nextReconnectAt: string | null = null
  #connectionIssue: BrokerConnectionDiagnostics['issue']
  #reconnectTimer: NodeJS.Timeout | undefined
  #apiStartupTimer: NodeJS.Timeout | undefined
  #reconciliationTimer: NodeJS.Timeout | undefined

  constructor(
    config: GatewayConfig['ibkr'],
    api?: IBApi,
    private readonly orderIds = new OrderIdAllocator(),
  ) {
    this.#config = config
    this.#connectionType = config.connectionType ?? inferConnectionType(config.port)
    this.#connectionLabel = connectionTypeLabel(this.#connectionType)
    this.#message = `${this.#connectionLabel} is not connected.`
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
      connection: {
        connectionType: this.#connectionType,
        clientId: this.#config.clientId,
        ...(this.#connectionIssue === undefined ? {} : { issue: this.#connectionIssue }),
        ...(this.#reconnectExhausted ||
        (this.#desiredConnection &&
          this.#state !== 'ready' &&
          (this.#reconnectTimer !== undefined ||
            (this.#reconnectAttempt > 0 &&
              (this.#state === 'connecting' || this.#state === 'reconciling')) ||
            this.#connectionIssue === 'client-id-in-use'))
          ? {
              retry: {
                attempt: this.#reconnectAttempt,
                maxAttempts: MAX_AUTOMATIC_RETRIES,
                exhausted: this.#reconnectExhausted,
                nextAttemptAt: this.#nextReconnectAt,
              },
            }
          : {}),
      },
      ...(this.#lastErrorCode === undefined ? {} : { lastErrorCode: this.#lastErrorCode }),
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber)
    subscriber(this.snapshot())
    return () => this.#subscribers.delete(subscriber)
  }

  connect(): void {
    if (!this.#desiredConnection) {
      this.#reconnectAttempt = 0
      this.#reconnectExhausted = false
      this.#connectionIssue = undefined
    }
    this.#desiredConnection = true
    if (this.#socketConnected || this.#state === 'connecting') return
    this.#clearReconnectTimer()
    this.#reconnectMessage = undefined
    this.#transition(
      'connecting',
      `Connecting to the local ${this.#connectionLabel} ${this.#config.executionEnvironment} session.`,
    )
    this.#api.connect(this.#config.clientId)
  }

  retryConnection(): void {
    if (this.#socketConnected || this.#state === 'connecting') return
    this.#desiredConnection = false
    this.connect()
  }

  disconnect(): void {
    this.#desiredConnection = false
    this.#reconnectExhausted = false
    this.#connectionIssue = undefined
    this.#reconnectMessage = undefined
    this.#clearReconnectTimer()
    this.#clearReconciliationTimer()
    this.#invalidateBrokerReadiness()
    this.#api.disconnect()
    this.#transition(
      'disconnected',
      `${this.#connectionLabel} was disconnected by the local operator.`,
    )
  }

  allocateOrderId(): number {
    if (this.#state !== 'ready' || !this.#nextOrderIdReady) {
      throw new Error(
        `${this.#connectionLabel} order allocation is unavailable until reconciliation is complete`,
      )
    }
    const allocated = this.orderIds.allocate()
    if (allocated === undefined)
      throw new Error(`${this.#connectionLabel} has not supplied a valid order ID`)
    return allocated
  }

  #registerListeners(): void {
    this.#api
      .on(EventName.connected, () => {
        if (!this.#desiredConnection) {
          this.#api.disconnect()
          return
        }
        this.#socketConnected = true
        this.#connectivityLost = false
        this.#transition(
          'connecting',
          `${this.#connectionLabel} socket connected; waiting for protocol readiness.`,
        )
        this.#clearApiStartupTimer()
        this.#apiStartupTimer = setTimeout(() => {
          this.#apiStartupTimer = undefined
          if (
            this.#desiredConnection &&
            this.#socketConnected &&
            !this.#nextOrderIdReady &&
            this.#state === 'connecting'
          ) {
            this.#connectionIssue = undefined
            this.#transition(
              'error',
              `${this.#connectionLabel} connected, but its API did not complete startup within 5 seconds. ${this.#connectionLabel} may still show a healthy connection. Check ${this.#connectionLabel}, restart it if needed, then retry the workstation.`,
            )
          }
        }, API_STARTUP_TIMEOUT_MS)
      })
      .on(EventName.disconnected, () => this.#handleDisconnected())
      .on(EventName.info, (message: string, code: number) => {
        this.#handleError(new Error(message), Number(code), -1)
      })
      .on(
        EventName.error,
        (error: Error, code: ErrorCode, requestId: number, _advancedOrderReject?: unknown) => {
          this.#handleError(error, Number(code), requestId)
        },
      )
      .on(EventName.managedAccounts, (accountsCsv: string) => {
        if (!this.#desiredConnection) return
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
        if (!this.#desiredConnection || this.#connectivityLost) return
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
    this.#clearApiStartupTimer()
    if (this.#accountSummaryRequestId !== undefined)
      this.#api.cancelAccountSummary(this.#accountSummaryRequestId)
    this.#accountSummaryRequestId = this.orderIds.allocateRequestId()
    this.#executionRequestId = this.orderIds.allocateRequestId()
    this.#progress = this.#emptyProgress()
    this.#openOrders.clear()
    this.#completedOrders.clear()
    this.#positions.clear()
    this.#executions.clear()
    this.#transition(
      'reconciling',
      `${this.#connectionLabel} protocol is ready; reconciling broker state.`,
    )

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
        this.#transition(
          'error',
          `${this.#connectionLabel} reconciliation timed out; trading remains disabled.`,
        )
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
    this.#transition(
      this.#reconnectExhausted ? 'error' : 'disconnected',
      this.#reconnectMessage ??
        `${this.#connectionLabel} is disconnected; check its sign-in and IBKR connection.`,
    )
    if (this.#desiredConnection) this.#scheduleReconnect()
  }

  #handleError(error: Error, code: number, requestId: number): void {
    if (!this.#desiredConnection) return
    this.#lastErrorCode = code
    if (code === 1100) {
      this.#connectionIssue = 'ibkr-connectivity-lost'
      this.#connectivityLost = true
      this.#invalidateBrokerReadiness()
      this.#transition('degraded', 'IBKR connectivity was lost; trading is frozen.')
      return
    }
    if (code === 1101 || code === 1102) {
      this.#connectionIssue = undefined
      this.#connectivityLost = false
      this.#initializedGeneration = undefined
      this.#invalidateBrokerReadiness()
      this.#transition('reconciling', 'IBKR connectivity returned; broker state is reconciling.')
      this.#api.reqIds()
      return
    }
    if (code === 326) {
      this.#connectionIssue = 'client-id-in-use'
      this.#invalidateBrokerReadiness()
      this.#reconnectMessage = `${this.#connectionLabel} client ID ${this.#config.clientId} is already in use; check its sign-in and IBKR connection.`
      this.#transition('degraded', this.#reconnectMessage)
      // Keep the operator's connection intent. Retry only once this rejected socket closes.
      this.#api.disconnect()
      return
    }
    if (code === 502 || code === 504) {
      this.#connectionIssue = undefined
      this.#clearApiStartupTimer()
      this.#transition(
        'error',
        `Unable to connect to ${this.#connectionLabel} on the configured port.`,
      )
      return
    }
    if (requestId >= 0) {
      // Request-scoped errors are surfaced by the owning IBKR operation. They must not
      // replace the session readiness message or make a healthy connection look stale.
      return
    }
    this.#message = `${this.#connectionLabel} reported code ${code}: ${error.message}`
    this.#notify()
  }

  #raiseOrderIdHighWatermark(orderId: number): void {
    if (!Number.isInteger(orderId) || orderId < 0) return
    this.orderIds.observeUsed(orderId)
    this.#notify()
  }

  #receiveNextValidOrderId(orderId: number): void {
    if (!Number.isInteger(orderId) || orderId < 0) return
    if (this.#connectionIssue === 'client-id-in-use') this.#connectionIssue = undefined
    this.orderIds.observeNextValid(orderId)
    this.#nextOrderIdReady = true
    this.#notify()
  }

  #maybeReady(): void {
    if (!this.#desiredConnection || !this.#socketConnected || this.#connectivityLost) return
    if (!this.#isReconciliationComplete()) return
    this.#clearReconciliationTimer()
    if (this.#managedAccountIds.length === 0) {
      this.#transition(
        'error',
        `${this.#connectionLabel} returned no managed accounts; trading remains disabled.`,
      )
      return
    }
    if (
      !accountsMatchExecutionEnvironment(this.#managedAccountIds, this.#config.executionEnvironment)
    ) {
      this.#transition(
        'error',
        `The ${this.#connectionLabel} account does not match the selected Live or Paper mode; trading remains disabled.`,
      )
      return
    }
    this.#reconnectAttempt = 0
    this.#reconnectExhausted = false
    this.#connectionIssue = undefined
    this.#transition('ready', `${this.#connectionLabel} account state is reconciled.`)
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
    this.#clearApiStartupTimer()
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
    if (this.#reconnectAttempt >= MAX_AUTOMATIC_RETRIES) {
      this.#desiredConnection = false
      this.#reconnectExhausted = true
      this.#transition('error', this.#message)
      return
    }
    const baseDelay = 1_000 * 2 ** this.#reconnectAttempt
    const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5))
    this.#reconnectAttempt += 1
    this.#nextReconnectAt = new Date(Date.now() + delay).toISOString()
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.#nextReconnectAt = null
      if (this.#desiredConnection) this.connect()
    }, delay)
    this.#notify()
  }

  #clearReconnectTimer(): void {
    this.#nextReconnectAt = null
    if (this.#reconnectTimer === undefined) return
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
  }

  #clearApiStartupTimer(): void {
    if (this.#apiStartupTimer === undefined) return
    clearTimeout(this.#apiStartupTimer)
    this.#apiStartupTimer = undefined
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
