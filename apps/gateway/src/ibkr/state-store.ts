import { brokerSymbolKey } from './contracts.js'
import type {
  AccountSummary,
  BridgeDiagnostic,
  BridgeMessage,
  BrokerEvent,
  BrokerState,
  ConnectionStatus,
  Execution,
  MarketDataConnection,
  MarketDepth,
  MarketQuote,
  Order,
  Position,
} from './types.js'

type Listener = (event: BrokerEvent) => void

function now(): string {
  return new Date().toISOString()
}

export class BrokerStateStore {
  private state: BrokerState = {
    connectionStatus: 'disconnected',
    accounts: [],
    orders: [],
    ordersHistory: [],
    positions: [],
    executions: [],
    quotes: [],
    messages: [],
    diagnostics: [],
    updatedAt: now(),
  }

  private readonly listeners = new Set<Listener>()
  private readonly unsettledMarketDepths = new Set<string>()
  private marketDepthEmit: ReturnType<typeof setImmediate> | undefined

  getState(): BrokerState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener({ type: 'state', state: this.state, timestamp: now() })
    return () => this.listeners.delete(listener)
  }

  setConnectionStatus(status: ConnectionStatus, message?: string): void {
    this.patchState({ connectionStatus: status })
    this.emit({ type: 'connection-status', status, message, timestamp: now() })
    if (message) {
      this.addDiagnostic(status === 'error' ? 'error' : 'info', message)
    }
  }

  setMarketDataConnection(connection: MarketDataConnection): void {
    this.patchState({ marketDataConnection: connection })
  }

  setAccounts(accounts: AccountSummary[], activeAccountId?: string | null): void {
    this.patchState({
      accounts,
      activeAccountId:
        activeAccountId === null
          ? undefined
          : activeAccountId && accounts.some((account) => account.id === activeAccountId)
            ? activeAccountId
            : this.state.activeAccountId &&
                accounts.some((account) => account.id === this.state.activeAccountId)
              ? this.state.activeAccountId
              : accounts[0]?.id,
    })
    this.emit({
      type: 'accounts',
      accounts: this.state.accounts,
      activeAccountId: this.state.activeAccountId,
      timestamp: now(),
    })
  }

  setActiveAccount(accountId: string): void {
    this.patchState({ activeAccountId: accountId })
    this.emit({
      type: 'accounts',
      accounts: this.state.accounts,
      activeAccountId: accountId,
      timestamp: now(),
    })
  }

  upsertOrder(order: Order): void {
    const historical = isHistoricalOrder(order)
    const orders = historical
      ? this.state.orders.filter((existing) => existing.id !== order.id)
      : upsertById(this.state.orders, order)
    const ordersHistory = historical
      ? upsertById(this.state.ordersHistory ?? [], order)
      : this.state.ordersHistory
    this.patchState({ orders, ordersHistory })
    this.emit({ type: 'orders', orders, timestamp: now() })
    this.emit({
      type: 'orders-history',
      orders: ordersHistory ?? [],
      timestamp: now(),
    })
  }

  setOrders(orders: Order[]): void {
    const historical = orders.filter(isHistoricalOrder)
    const openOrders = orders.filter((order) => !isHistoricalOrder(order))
    const ordersHistory = historical.reduce(
      (items, order) => upsertById(items, order),
      this.state.ordersHistory ?? [],
    )
    this.patchState({ orders: openOrders, ordersHistory })
    this.emit({ type: 'orders', orders: openOrders, timestamp: now() })
    this.emit({
      type: 'orders-history',
      orders: ordersHistory,
      timestamp: now(),
    })
  }

  upsertPosition(position: Position): void {
    const existing = this.state.positions.find((item) => item.id === position.id)
    const nextPosition = existing ? { ...existing, ...position } : position
    if (existing && existing.quantity !== position.quantity) {
      // Portfolio amounts describe a particular quantity. A position-only callback
      // must not keep valuations or PnL belonging to the previous size.
      for (const field of ['marketValue', 'unrealizedPnl', 'realizedPnl'] as const) {
        if (!Object.hasOwn(position, field)) delete nextPosition[field]
      }
    }
    const positions =
      position.quantity === 0
        ? this.state.positions.filter((item) => item.id !== position.id)
        : upsertById(this.state.positions, nextPosition)
    this.patchState({ positions })
    this.emit({ type: 'positions', positions, timestamp: now() })
  }

  reconcilePositions(positionIds: ReadonlySet<string>): void {
    const positions = this.state.positions.filter((position) => positionIds.has(position.id))
    this.patchState({ positions })
    this.emit({ type: 'positions', positions, timestamp: now() })
  }

  setExecutions(executions: Execution[]): void {
    const reconciled = executions.reduce(upsertExecutionByIdentity, [] as Execution[])
    this.patchState({ executions: reconciled })
    this.emit({ type: 'executions', executions: reconciled, timestamp: now() })
  }

  upsertExecution(execution: Execution): boolean {
    const executions = upsertExecutionByIdentity(this.state.executions, execution)
    if (executions === this.state.executions) return false
    this.patchState({ executions })
    this.emit({ type: 'executions', executions, timestamp: now() })
    return true
  }

  marketDepth(streamId: string): MarketDepth | undefined {
    return this.state.marketDepths?.find((depth) => depth.streamId === streamId)
  }

  setMarketDepth(marketDepth: MarketDepth): void {
    const others = (this.state.marketDepths ?? []).filter(
      (depth) => depth.streamId !== marketDepth.streamId,
    )
    this.patchState({ marketDepths: [...others, marketDepth] })
    // IBKR delivers one book change as a burst of level operations. Reads stay current, but
    // clients get each settled book once per event-loop turn, never the in-between states.
    this.unsettledMarketDepths.add(marketDepth.streamId)
    if (this.marketDepthEmit) return
    this.marketDepthEmit = setImmediate(() => {
      this.marketDepthEmit = undefined
      const streamIds = [...this.unsettledMarketDepths]
      this.unsettledMarketDepths.clear()
      for (const streamId of streamIds) {
        const settled = this.marketDepth(streamId)
        if (settled) this.emit({ type: 'market-depth', marketDepth: settled, timestamp: now() })
      }
    })
  }

  removeMarketDepth(streamId: string): void {
    if (!this.marketDepth(streamId)) return
    this.unsettledMarketDepths.delete(streamId)
    this.patchState({
      marketDepths: (this.state.marketDepths ?? []).filter((depth) => depth.streamId !== streamId),
    })
  }

  invalidatePortfolio(accountId: string): void {
    const positions = this.state.positions.map((position) => {
      if (position.accountId !== accountId) return position
      const {
        markPrice: _markPrice,
        marketValue: _marketValue,
        unrealizedPnl: _unrealizedPnl,
        realizedPnl: _realizedPnl,
        ...current
      } = position
      return current
    })
    this.patchState({ positions })
    this.emit({ type: 'positions', positions, timestamp: now() })
  }

  upsertQuote(quote: MarketQuote): void {
    const quotes = upsertByQuoteKey(this.state.quotes, quote)
    this.patchState({ quotes })
    this.emit({ type: 'quotes', quotes: [quote], timestamp: now() })
  }

  addMessage(level: BridgeMessage['level'], text: string): BridgeMessage {
    const message: BridgeMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      level,
      text,
      timestamp: now(),
    }
    this.patchState({ messages: [...this.state.messages.slice(-99), message] })
    this.emit({ type: 'message', message, timestamp: now() })
    return message
  }

  addDiagnostic(level: BridgeDiagnostic['level'], text: string): BridgeDiagnostic {
    const diagnostic: BridgeDiagnostic = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      level,
      text,
      timestamp: now(),
    }
    this.patchState({
      diagnostics: [...this.state.diagnostics.slice(-199), diagnostic],
    })
    this.emit({ type: 'diagnostic', diagnostic, timestamp: now() })
    return diagnostic
  }

  private patchState(patch: Partial<BrokerState>): void {
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: now(),
    }
  }

  private emit(event: BrokerEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id)
  if (index === -1) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

function upsertExecutionByIdentity(items: Execution[], execution: Execution): Execution[] {
  const incoming = executionRevision(execution.id)
  const index = items.findIndex((existing) => {
    if (existing.id === execution.id) return true
    const current = executionRevision(existing.id)
    return (
      current.identity === incoming.identity &&
      existing.orderId === execution.orderId &&
      existing.accountId === execution.accountId
    )
  })
  if (index === -1) return [...items, execution]
  const current = executionRevision(items[index]?.id ?? '')
  if (
    current.revision !== undefined &&
    incoming.revision !== undefined &&
    incoming.revision < current.revision
  ) {
    return items
  }
  const next = [...items]
  const previousTimestamp = items[index]?.timestamp
  next[index] =
    !Number.isFinite(Date.parse(execution.timestamp)) &&
    previousTimestamp !== undefined &&
    Number.isFinite(Date.parse(previousTimestamp))
      ? { ...execution, timestamp: previousTimestamp }
      : execution
  return next
}

function executionRevision(id: string): {
  identity: string
  revision?: number | undefined
} {
  const match = /^(.*)\.(\d+)$/.exec(id)
  if (!match) return { identity: id }
  return { identity: match[1] ?? id, revision: Number(match[2]) }
}

function isHistoricalOrder(order: Order): boolean {
  return (
    order.status === 'filled' ||
    order.status === 'cancelled' ||
    order.status === 'rejected' ||
    order.customFields?.ibkrCompleted === true
  )
}

function upsertByQuoteKey(items: MarketQuote[], item: MarketQuote): MarketQuote[] {
  const key = quoteKey(item)
  const index = items.findIndex((existing) => quoteKey(existing) === key)
  if (index === -1) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

function quoteKey(quote: MarketQuote): string {
  return brokerSymbolKey(quote.symbol)
}
