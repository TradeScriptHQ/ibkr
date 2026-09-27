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

  setAccounts(accounts: AccountSummary[], activeAccountId?: string): void {
    this.patchState({
      accounts,
      activeAccountId: activeAccountId ?? this.state.activeAccountId ?? accounts[0]?.id,
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
    this.emit({ type: 'orders-history', orders: ordersHistory ?? [], timestamp: now() })
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
    this.emit({ type: 'orders-history', orders: ordersHistory, timestamp: now() })
  }

  upsertPosition(position: Position): void {
    const existing = this.state.positions.find((item) => item.id === position.id)
    const nextPosition = existing ? { ...existing, ...position } : position
    const positions =
      position.quantity === 0
        ? this.state.positions.filter((item) => item.id !== position.id)
        : upsertById(this.state.positions, nextPosition)
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

  setMarketDepth(marketDepth: MarketDepth): void {
    this.patchState({ marketDepth })
    this.emit({ type: 'market-depth', marketDepth, timestamp: now() })
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
    this.patchState({ diagnostics: [...this.state.diagnostics.slice(-199), diagnostic] })
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
  next[index] = execution
  return next
}

function executionRevision(id: string): { identity: string; revision?: number | undefined } {
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
  return [
    quote.symbol.assetClass ?? 'stock',
    quote.symbol.symbol,
    quote.symbol.exchange ?? '',
    quote.symbol.currency ?? '',
  ].join(':')
}
