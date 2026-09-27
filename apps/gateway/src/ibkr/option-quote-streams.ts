import { type Contract, IBApiTickType } from '@stoqey/ib'

export interface OptionStreamQuote {
  bid?: number | undefined
  ask?: number | undefined
  last?: number | undefined
  mark?: number | undefined
  volume?: number | undefined
  impliedVolatility?: number | undefined
  delta?: number | undefined
  gamma?: number | undefined
  theta?: number | undefined
  vega?: number | undefined
  quoteTimestamp?: string | undefined
  marketDataType?: 'live' | 'frozen' | 'delayed' | 'delayed-frozen' | undefined
}

interface Entry {
  reqId: number
  contract: Contract
  quote: OptionStreamQuote
  bidSize?: number | undefined
  askSize?: number | undefined
  pendingBidPrice?: number | undefined
  pendingAskPrice?: number | undefined
  timeout: ReturnType<typeof setTimeout>
}

export type OptionStreamListener = (contract: Contract, quote: OptionStreamQuote) => void

/** Retain the requested TWS quote window without an application-imposed size cap. */
export class OptionQuoteStreams {
  private readonly entries = new Map<string, Entry>()
  private readonly byRequest = new Map<number, Entry>()
  private readQueue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(key: string) => void>()
  private readonly retainCounts = new Map<string, number>()

  /** Keep a requested window alive until its initial quotes can be returned. */
  readManyReady(contracts: readonly Contract[]): Promise<OptionStreamQuote[]> {
    const read = this.readQueue.then(async () => {
      this.readMany(contracts)
      const snapshot = () =>
        contracts.map((contract) => ({ ...this.entries.get(this.key(contract))?.quote }))
      const ready = () => snapshot().every((quote) => quote.bid != null && quote.ask != null)
      if (!ready()) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            this.listeners.delete(changed)
            resolve()
          }
          const changed = () => {
            if (ready()) finish()
          }
          const timer = setTimeout(finish, 2000)
          this.listeners.add(changed)
        })
      }
      return snapshot()
    })
    this.readQueue = read.catch(() => undefined)
    return read
  }

  constructor(
    private readonly start: (reqId: number, contract: Contract) => void,
    private readonly cancel: (reqId: number) => void,
    private readonly allocate: () => number,
    private readonly idleMs = 15_000,
  ) {}

  readMany(contracts: readonly Contract[]): OptionStreamQuote[] {
    // Release contracts outside the requested window, preserving all overlaps.
    const requested = new Set(contracts.map((contract) => this.key(contract)))
    for (const key of this.entries.keys()) {
      if (!requested.has(key) && !this.retainCounts.has(key)) this.remove(key)
    }
    return contracts.map((contract) => this.read(contract))
  }

  /** Retain an exact quote window and push every matching TWS tick until released. */
  subscribeMany(contracts: readonly Contract[], listener: OptionStreamListener): () => void {
    const uniqueContracts = new Map(contracts.map((contract) => [this.key(contract), contract]))
    for (const [key, contract] of uniqueContracts) {
      this.read(contract)
      this.retainCounts.set(key, (this.retainCounts.get(key) ?? 0) + 1)
    }
    const changed = (key: string) => {
      const contract = uniqueContracts.get(key)
      const quote = this.entries.get(key)?.quote
      if (contract && quote) listener(contract, { ...quote })
    }
    this.listeners.add(changed)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      this.listeners.delete(changed)
      for (const key of uniqueContracts.keys()) {
        const count = this.retainCounts.get(key) ?? 0
        if (count <= 1) {
          this.retainCounts.delete(key)
          const entry = this.entries.get(key)
          if (entry) this.touch(key, entry)
        } else {
          this.retainCounts.set(key, count - 1)
        }
      }
    }
  }

  read(contract: Contract): OptionStreamQuote {
    const key = this.key(contract)
    let entry = this.entries.get(key)
    if (!entry) {
      const reqId = this.allocate()
      entry = { reqId, contract, quote: {}, timeout: this.expiry(key) }
      this.entries.set(key, entry)
      this.byRequest.set(reqId, entry)
      try {
        this.start(reqId, contract)
      } catch (error) {
        this.remove(key)
        throw error
      }
    } else {
      this.touch(key, entry)
    }
    return { ...entry.quote }
  }

  has(reqId: number): boolean {
    return this.byRequest.has(reqId)
  }

  price(reqId: number, field: number, value: number): boolean {
    const entry = this.byRequest.get(reqId)
    if (!entry) return false
    if (!Number.isFinite(value)) return true
    const key = (
      { 1: 'bid', 2: 'ask', 4: 'last', 37: 'mark', 66: 'bid', 67: 'ask', 68: 'last' } as const
    )[field]
    if (key === 'bid' || key === 'ask') {
      const pending = key === 'bid' ? 'pendingBidPrice' : 'pendingAskPrice'
      if (value < 0) {
        entry[pending] = value
        delete entry.quote[key]
      } else if (value === 0) {
        // Zero may be valid (positive size) or unavailable (size 0); resolve on size.
        entry[pending] = value
      } else {
        entry[pending] = undefined
        entry.quote[key] = value
      }
    } else if (key) {
      if (value > 0) entry.quote[key] = value
      else delete entry.quote[key]
    }
    if (key) entry.quote.quoteTimestamp = new Date().toISOString()
    if (key) this.emit(this.key(entry.contract))
    return true
  }

  dataType(reqId: number, marketDataType: number): boolean {
    const entry = this.byRequest.get(reqId)
    if (!entry) return false
    const type = ({ 1: 'live', 2: 'frozen', 3: 'delayed', 4: 'delayed-frozen' } as const)[
      marketDataType
    ]
    if (type) {
      entry.quote.marketDataType = type
      this.emit(this.key(entry.contract))
    }
    return true
  }

  /** Apply the canonical TWS model computation, matching the Greeks displayed by TWS. */
  computation(
    reqId: number,
    field: number,
    impliedVolatility?: number,
    delta?: number,
    optionPrice?: number,
    gamma?: number,
    vega?: number,
    theta?: number,
  ): boolean {
    const entry = this.byRequest.get(reqId)
    if (!entry) return false
    if (field !== IBApiTickType.MODEL_OPTION && field !== IBApiTickType.DELAYED_MODEL_OPTION) {
      return true
    }
    this.assignFinite(entry.quote, 'impliedVolatility', impliedVolatility)
    this.assignFinite(entry.quote, 'delta', delta)
    this.assignFinite(entry.quote, 'mark', optionPrice)
    this.assignFinite(entry.quote, 'gamma', gamma)
    this.assignFinite(entry.quote, 'vega', vega)
    this.assignFinite(entry.quote, 'theta', theta)
    entry.quote.quoteTimestamp = new Date().toISOString()
    this.emit(this.key(entry.contract))
    return true
  }

  size(reqId: number, field?: number, value?: number): boolean {
    const entry = this.byRequest.get(reqId)
    if (!entry) return false
    if (value == null || !Number.isFinite(value) || value < 0) return true
    if (field === 0 || field === 69) {
      entry.bidSize = value
      const pendingPrice = entry.pendingBidPrice
      if (pendingPrice !== undefined) {
        entry.pendingBidPrice = undefined
        if (pendingPrice < 0 || value === 0) delete entry.quote.bid
        else entry.quote.bid = pendingPrice
      }
      this.emit(this.key(entry.contract))
      return true
    }
    if (field === 3 || field === 70) {
      entry.askSize = value
      const pendingPrice = entry.pendingAskPrice
      if (pendingPrice !== undefined) {
        entry.pendingAskPrice = undefined
        if (pendingPrice < 0 || value === 0) delete entry.quote.ask
        else entry.quote.ask = pendingPrice
      }
      this.emit(this.key(entry.contract))
      return true
    }
    if ((field === 8 || field === 74) && value != null && Number.isFinite(value) && value >= 0) {
      entry.quote.volume = value
      this.emit(this.key(entry.contract))
    }
    return true
  }

  clear(): void {
    for (const key of this.entries.keys()) this.remove(key)
    this.retainCounts.clear()
  }

  restore(): void {
    for (const [key, entry] of this.entries) {
      clearTimeout(entry.timeout)
      this.byRequest.delete(entry.reqId)
      const reqId = this.allocate()
      const restored: Entry = {
        reqId,
        contract: entry.contract,
        quote: {},
        timeout: this.expiry(key),
      }
      this.entries.set(key, restored)
      this.byRequest.set(reqId, restored)
      this.start(reqId, restored.contract)
    }
    for (const key of this.entries.keys()) this.emit(key)
  }

  private key(contract: Contract): string {
    return `${contract.conId}:${contract.exchange ?? 'SMART'}:${contract.currency ?? 'USD'}`
  }

  private touch(key: string, entry: Entry): void {
    clearTimeout(entry.timeout)
    entry.timeout = this.expiry(key)
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private expiry(key: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (!this.retainCounts.has(key)) this.remove(key)
    }, this.idleMs)
    timer.unref?.()
    return timer
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    clearTimeout(entry.timeout)
    this.entries.delete(key)
    this.byRequest.delete(entry.reqId)
    this.cancel(entry.reqId)
  }

  private emit(key: string): void {
    for (const listener of this.listeners) listener(key)
  }

  private assignFinite<K extends keyof OptionStreamQuote>(
    quote: OptionStreamQuote,
    key: K,
    value: OptionStreamQuote[K],
  ): void {
    if (typeof value === 'number' && Number.isFinite(value)) quote[key] = value
    else delete quote[key]
  }
}
