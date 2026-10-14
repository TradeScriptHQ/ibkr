import { type IBApi, TickByTickDataType } from '@stoqey/ib'
import { brokerSymbolKey, normalizeBrokerSymbol, toIbContract } from './contracts.js'
import { RequestError } from './request-error.js'
import type { BrokerStateStore } from './state-store.js'
import { AggressorClassifier, type TopOfBook, type TradeAggressor } from './trade-aggressor.js'
import type { BrokerSymbol, MarketDepth } from './types.js'

export const DEPTH_PENDING_MESSAGE =
  'Gateway depth pending: IBKR has not returned rows or a request-specific diagnostic.'
export const DEPTH_NO_RESPONSE_MESSAGE =
  'Gateway depth no response: IBKR has not returned rows or a request-specific diagnostic within 15 seconds; availability is unknown.'

const DEPTH_PENDING_TIMEOUT_MS = 15_000
/** A claim outlives its last use by this long once no connection of its client is open. */
const CLAIM_IDLE_MS = 30_000
const CLAIM_SWEEP_MS = 5_000
/** An unclaimed stream lingers so a quick symbol flip back does not resubscribe at IBKR. */
const STREAM_LINGER_MS = 5_000
const TAPE_MIN_RETENTION = 1_000
/** Footprint history pages ask for far more prints than a session needs; memory stays bounded. */
const TAPE_MAX_RETENTION = 50_000
/** IBKR's per-account limits on concurrent market-depth and tick-by-tick requests. */
const DEPTH_LIMIT_CODE = 309
const TAPE_LIMIT_CODE = 10190

/** Who wants a stream: one claim per widget subscription, owned by one client (window). */
export interface StreamClaimRequest {
  claimId?: string | undefined
  clientId?: string | undefined
}

export interface TapePrint {
  time: number
  price: number
  /** Omitted when IBKR does not report the traded quantity. */
  size?: number | undefined
  venue?: string | undefined
  conditions?: string[] | undefined
  /** Inferred initiating side; omitted until the quote or tick direction can tell. */
  aggressor?: TradeAggressor | undefined
  sequence: number
}

/** Bounds on a tape read, for paging history backwards. */
export interface TapeRange {
  startTime?: number | undefined
  endTime?: number | undefined
  beforeSequence?: number | undefined
}

interface StreamFailure {
  message: string
  code?: number | undefined
  attempt: number
  retryAt: number
}

interface StreamBase {
  key: string
  symbol: BrokerSymbol
  reqId?: number | undefined
  lingerTimer?: ReturnType<typeof setTimeout> | undefined
  failure?: StreamFailure | undefined
}

interface DepthStream extends StreamBase {
  kind: 'depth'
  rows: number
  pendingTimer?: ReturnType<typeof setTimeout> | undefined
}

interface TapeStream extends StreamBase {
  kind: 'tape'
  prints: TapePrint[]
  sequence: number
  retention: number
  classifier: AggressorClassifier
}

type Stream = DepthStream | TapeStream

interface Claim {
  id: string
  clientId?: string | undefined
  streamKey: string
  touchedAt: number
}

/**
 * Owns market-depth and time-and-sales streams, one per exact contract. Every window or tool that
 * reads a stream holds a claim on it; a stream lives at IBKR while any claim is alive, so windows
 * watching different symbols never take a stream from each other.
 */
export class MarketStreams {
  private readonly streams = new Map<string, Stream>()
  private readonly claims = new Map<string, Claim>()
  private readonly openConnections = new Map<string, number>()
  /** Backoff outlives a removed stream, so a reader returning later cannot retry early. */
  private readonly recentFailures = new Map<string, StreamFailure>()
  private sweepTimer?: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly ib: IBApi,
    private readonly store: BrokerStateStore,
    private readonly allocateRequestId: () => number,
  ) {}

  /** Register an open event connection of a client; its claims stay alive until it closes. */
  connectClient(clientId: string): () => void {
    this.openConnections.set(clientId, (this.openConnections.get(clientId) ?? 0) + 1)
    let open = true
    return () => {
      if (!open) return
      open = false
      const remaining = (this.openConnections.get(clientId) ?? 1) - 1
      if (remaining > 0) {
        this.openConnections.set(clientId, remaining)
        return
      }
      this.openConnections.delete(clientId)
      // The client may reconnect its event stream; its claims get the idle allowance from now.
      const now = Date.now()
      for (const claim of this.claims.values())
        if (claim.clientId === clientId) claim.touchedAt = now
    }
  }

  release(claimIds: readonly string[], clientId: string | undefined): void {
    for (const claimId of claimIds) {
      const claim = this.claims.get(claimId)
      if (!claim || claim.clientId !== clientId) continue
      this.claims.delete(claimId)
      this.releaseIfUnclaimed(claim.streamKey)
    }
  }

  depth(symbol: BrokerSymbol, rows: number, claim?: StreamClaimRequest): MarketDepth {
    const normalized = normalizeBrokerSymbol(symbol)
    const key = `depth:${brokerSymbolKey(normalized)}`
    this.claim(key, claim)
    const existing = this.streams.get(key)
    if (existing?.kind !== 'depth') {
      this.yieldLingering('depth')
      const failure = this.recallFailure(key)
      const stream: DepthStream = { kind: 'depth', key, symbol: normalized, rows, failure }
      this.streams.set(key, stream)
      if (!failure) this.subscribe(stream)
      else
        this.store.setMarketDepth({
          ...this.emptyBook(stream),
          diagnostic: {
            message: failure.message,
            ...(failure.code == null ? {} : { code: failure.code }),
          },
        })
    } else {
      this.keep(existing)
      if (rows > existing.rows) {
        existing.rows = rows
        this.subscribe(existing)
      } else if (existing.reqId === undefined && this.retryDue(existing)) {
        this.subscribe(existing)
      }
    }
    return (
      this.store.marketDepth(key) ?? {
        streamId: key,
        symbol: normalized,
        bids: [],
        asks: [],
        updatedAt: new Date().toISOString(),
        diagnostic: { message: DEPTH_PENDING_MESSAGE },
      }
    )
  }

  tape(
    symbol: BrokerSymbol,
    limit: number,
    claim?: StreamClaimRequest,
    range: TapeRange = {},
  ): TapePrint[] {
    const normalized = normalizeBrokerSymbol(symbol)
    const key = `tape:${brokerSymbolKey(normalized)}`
    this.claim(key, claim)
    let stream = this.streams.get(key)
    if (stream?.kind !== 'tape') {
      this.yieldLingering('tape')
      stream = {
        kind: 'tape',
        key,
        symbol: normalized,
        prints: [],
        sequence: 0,
        retention: 0,
        classifier: new AggressorClassifier(),
        failure: this.recallFailure(key),
      }
      this.streams.set(key, stream)
    } else {
      this.keep(stream)
    }
    stream.retention = Math.min(
      TAPE_MAX_RETENTION,
      Math.max(stream.retention, limit, TAPE_MIN_RETENTION),
    )
    if (stream.reqId === undefined) {
      if (!this.retryDue(stream)) throw new RequestError(503, stream.failure?.message ?? '')
      this.subscribe(stream)
    }
    if (stream.failure) throw new RequestError(503, stream.failure.message)
    const { startTime, endTime, beforeSequence } = range
    const count = Math.min(limit, stream.retention)
    if (startTime === undefined && endTime === undefined && beforeSequence === undefined)
      return stream.prints.slice(-count)
    const selected: TapePrint[] = []
    const oldest = Math.max(0, stream.prints.length - stream.retention)
    for (
      let index = stream.prints.length - 1;
      index >= oldest && selected.length < count;
      index--
    ) {
      const print = stream.prints[index] as TapePrint
      if (startTime !== undefined && print.time < startTime) break
      if (endTime !== undefined && print.time > endTime) continue
      if (beforeSequence !== undefined && print.sequence >= beforeSequence) continue
      selected.push(print)
    }
    return selected.reverse()
  }

  handleDepthUpdate(
    reqId: number,
    position: number,
    operation: number,
    side: number,
    price: number,
    size: number,
    marketMaker?: string,
  ): void {
    const stream = this.streamFor(reqId)
    if (stream?.kind !== 'depth' || position < 0) return
    const current = this.store.marketDepth(stream.key) ?? this.emptyBook(stream)
    const levels = [...(side === 1 ? current.bids : current.asks)]
    if (operation === 2) {
      levels.splice(position, 1)
    } else {
      const level = { price, size, ...(marketMaker ? { marketMaker } : {}) }
      if (operation === 0) levels.splice(position, 0, level)
      else levels[position] = level
    }
    const bids = side === 1 ? levels.slice(0, stream.rows) : current.bids
    const asks = side === 0 ? levels.slice(0, stream.rows) : current.asks
    const usable = [...bids, ...asks].some(
      (level) =>
        Number.isFinite(level.price) &&
        level.price > 0 &&
        Number.isFinite(level.size) &&
        level.size > 0,
    )
    const localDiagnostic =
      current.diagnostic?.message === DEPTH_PENDING_MESSAGE ||
      current.diagnostic?.message === DEPTH_NO_RESPONSE_MESSAGE
    const recoveredDiagnostic = [316, 317, 1101].includes(current.diagnostic?.code ?? 0)
    if (usable) {
      this.clearPending(stream)
      stream.failure = undefined
    }
    this.store.setMarketDepth({
      ...current,
      symbol: stream.symbol,
      bids,
      asks,
      diagnostic:
        usable && (localDiagnostic || recoveredDiagnostic) ? undefined : current.diagnostic,
      updatedAt: new Date().toISOString(),
    })
  }

  handleTick(
    reqId: number,
    time: string,
    price: number,
    size: number,
    exchange: string,
    specialConditions: string,
  ): void {
    const stream = this.streamFor(reqId)
    if (stream?.kind !== 'tape') return
    stream.failure = undefined
    const seconds = Number(time)
    // IBKR's tick-by-tick crypto prints carry a placeholder size of 1; the real (fractional)
    // trade sizes arrive only on the quote stream, so the print reports no size at all.
    const reportsSize = stream.symbol.assetClass !== 'crypto'
    const aggressor = stream.classifier.classify(price, this.topOfBook(stream))
    stream.prints.push({
      time: Number.isFinite(seconds) ? seconds * 1_000 : Date.now(),
      price,
      ...(reportsSize ? { size } : {}),
      ...(exchange ? { venue: exchange } : {}),
      ...(specialConditions ? { conditions: specialConditions.split(',').filter(Boolean) } : {}),
      ...(aggressor ? { aggressor } : {}),
      sequence: ++stream.sequence,
    })
    // Trim in batches so a busy tape does not copy its whole history on every print.
    if (stream.prints.length > stream.retention + Math.max(64, stream.retention >> 3))
      stream.prints.splice(0, stream.prints.length - stream.retention)
  }

  /**
   * The freshest real-time bid/ask the gateway already holds for a tape's contract: the top of
   * its depth book or its quote. Delayed and frozen quotes cannot classify live prints.
   */
  private topOfBook(stream: TapeStream): TopOfBook | undefined {
    const key = stream.key.slice('tape:'.length)
    const depth = this.store.marketDepth(`depth:${key}`)
    const depthBook =
      depth && depth.bids[0] && depth.asks[0]
        ? { bid: depth.bids[0].price, ask: depth.asks[0].price, at: Date.parse(depth.updatedAt) }
        : undefined
    const quote = this.store
      .getState()
      .quotes.find((candidate) => brokerSymbolKey(candidate.symbol) === key)
    const quoteBook =
      quote?.status === 'ok' &&
      (quote.marketDataType === undefined || quote.marketDataType === 'live') &&
      quote.bid !== undefined &&
      quote.ask !== undefined
        ? { bid: quote.bid, ask: quote.ask, at: Date.parse(quote.timestamp) }
        : undefined
    if (depthBook && (!quoteBook || !(quoteBook.at > depthBook.at))) return depthBook
    return quoteBook
  }

  /** Route a request-scoped IBKR error to the stream that owns the request. */
  handleError(error: Error, code: number | undefined, reqId: number, suffix: string): boolean {
    const stream = this.streamFor(reqId)
    if (!stream) return false
    if (stream.kind === 'tape') {
      stream.failure = this.nextFailure(stream, `${error.message}${suffix}`, code)
      stream.reqId = undefined
      stream.prints = []
      this.ib.cancelTickByTickData(reqId)
      this.store.addDiagnostic('warning', `Time and sales: ${error.message}${suffix}`)
      return true
    }
    this.clearPending(stream)
    this.store.addDiagnostic('warning', `${error.message}${suffix}`)
    if (code === 316) {
      this.subscribe(stream, { message: error.message, code })
      return true
    }
    const current = this.store.marketDepth(stream.key) ?? this.emptyBook(stream)
    if (code === DEPTH_LIMIT_CODE) {
      // IBKR refused this book because the account's concurrent limit is reached. Keep the
      // claim and retry once another book closes or the backoff elapses; never take a slot.
      stream.failure = this.nextFailure(stream, error.message, code)
      stream.reqId = undefined
    }
    this.store.setMarketDepth({
      ...current,
      ...(code === 317 || code === DEPTH_LIMIT_CODE ? { bids: [], asks: [] } : {}),
      diagnostic: { message: error.message, ...(code == null ? {} : { code }) },
    })
    return true
  }

  /** IBKR or its market data became unavailable: books keep their claims with no rows. */
  invalidate(message: string): void {
    for (const stream of this.streams.values()) {
      if (stream.kind !== 'depth') continue
      this.clearPending(stream)
      if (this.ib.isConnected && stream.reqId !== undefined)
        this.ib.cancelMktDepth(stream.reqId, true)
      stream.reqId = undefined
      const book = this.store.marketDepth(stream.key)
      if (book)
        this.store.setMarketDepth({
          streamId: book.streamId,
          symbol: book.symbol,
          bids: [],
          asks: [],
          updatedAt: book.updatedAt,
          diagnostic: { message },
        })
    }
  }

  /** The API connection closed: every IBKR request id is gone. */
  disconnected(): void {
    for (const stream of this.streams.values()) {
      stream.reqId = undefined
      if (stream.kind === 'depth') this.clearPending(stream)
      else {
        stream.failure = undefined
        stream.prints = []
      }
    }
  }

  /**
   * Resubscribe claimed streams after reconnection or reconciliation. Books always return; a tape
   * returns only if it was live, since a failed or dropped tape resubscribes on its next read.
   */
  restore(message: string, code?: number): void {
    this.sweep()
    for (const stream of this.streams.values()) {
      if (stream.lingerTimer) continue
      if (stream.kind === 'tape' && stream.reqId === undefined) continue
      this.subscribe(
        stream,
        stream.kind === 'depth' && code != null ? { message, code } : undefined,
      )
    }
  }

  private claim(streamKey: string, request: StreamClaimRequest | undefined): void {
    const id = request?.claimId ?? `anonymous:${streamKey}`
    const previous = this.claims.get(id)
    this.claims.set(id, { id, clientId: request?.clientId, streamKey, touchedAt: Date.now() })
    if (previous && previous.streamKey !== streamKey) this.releaseIfUnclaimed(previous.streamKey)
    this.sweepTimer ??= setInterval(() => this.sweep(), CLAIM_SWEEP_MS)
    this.sweepTimer.unref?.()
  }

  private sweep(): void {
    const now = Date.now()
    const released = new Set<string>()
    for (const claim of this.claims.values()) {
      const connected = claim.clientId !== undefined && this.openConnections.has(claim.clientId)
      if (connected || now - claim.touchedAt < CLAIM_IDLE_MS) continue
      this.claims.delete(claim.id)
      released.add(claim.streamKey)
    }
    for (const key of released) this.releaseIfUnclaimed(key)
    if (this.claims.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  private releaseIfUnclaimed(key: string): void {
    for (const claim of this.claims.values()) if (claim.streamKey === key) return
    const stream = this.streams.get(key)
    if (!stream || stream.lingerTimer) return
    stream.lingerTimer = setTimeout(() => this.remove(key), STREAM_LINGER_MS)
    stream.lingerTimer.unref?.()
  }

  private keep(stream: Stream): void {
    if (!stream.lingerTimer) return
    clearTimeout(stream.lingerTimer)
    stream.lingerTimer = undefined
  }

  /** Unclaimed streams give their IBKR slot to a new stream of the same kind immediately. */
  private yieldLingering(kind: Stream['kind']): void {
    for (const stream of [...this.streams.values()])
      if (stream.kind === kind && stream.lingerTimer) this.remove(stream.key)
  }

  private remove(key: string): void {
    const stream = this.streams.get(key)
    if (!stream) return
    if (stream.lingerTimer) clearTimeout(stream.lingerTimer)
    this.streams.delete(key)
    this.cancel(stream)
    if (stream.failure && stream.failure.retryAt > Date.now())
      this.recentFailures.set(key, stream.failure)
    if (stream.kind === 'depth') this.store.removeMarketDepth(key)
    // A closed stream frees an IBKR slot for one that hit the account limit.
    for (const waiting of this.streams.values()) {
      if (waiting.kind !== stream.kind || waiting.reqId !== undefined) continue
      if (waiting.failure?.code !== (stream.kind === 'depth' ? DEPTH_LIMIT_CODE : TAPE_LIMIT_CODE))
        continue
      waiting.failure.retryAt = 0
      if (waiting.kind === 'depth') this.subscribe(waiting)
    }
  }

  private cancel(stream: Stream): void {
    if (stream.reqId === undefined) return
    if (stream.kind === 'depth') {
      this.clearPending(stream)
      this.ib.cancelMktDepth(stream.reqId, true)
    } else {
      this.ib.cancelTickByTickData(stream.reqId)
    }
    stream.reqId = undefined
  }

  private subscribe(stream: Stream, diagnostic?: { message: string; code: number }): void {
    if (this.store.getState().connectionStatus !== 'connected') return
    this.cancel(stream)
    const reqId = this.allocateRequestId()
    stream.reqId = reqId
    const contract = toIbContract(stream.symbol)
    if (stream.kind === 'tape') {
      stream.prints = []
      stream.sequence = 0
      this.ib.reqTickByTickData(reqId, contract, TickByTickDataType.AllLast, 0, false)
      this.store.addDiagnostic('info', `Subscribed time and sales for ${stream.symbol.symbol}`)
      return
    }
    this.store.setMarketDepth({
      ...this.emptyBook(stream),
      diagnostic: diagnostic ?? { message: DEPTH_PENDING_MESSAGE },
    })
    if (!diagnostic) this.armPending(stream, reqId)
    this.ib.reqMktDepth(reqId, contract, stream.rows, true, [])
    this.store.addDiagnostic('info', `Subscribed market depth for ${stream.symbol.symbol}`)
  }

  private armPending(stream: DepthStream, reqId: number): void {
    this.clearPending(stream)
    stream.pendingTimer = setTimeout(() => {
      stream.pendingTimer = undefined
      if (stream.reqId !== reqId) return
      const book = this.store.marketDepth(stream.key)
      if (!book || book.diagnostic?.message !== DEPTH_PENDING_MESSAGE) return
      // This is a local observation of silence, not an invented provider error.
      this.store.setMarketDepth({ ...book, diagnostic: { message: DEPTH_NO_RESPONSE_MESSAGE } })
    }, DEPTH_PENDING_TIMEOUT_MS)
    stream.pendingTimer.unref?.()
  }

  private clearPending(stream: DepthStream): void {
    if (stream.pendingTimer) clearTimeout(stream.pendingTimer)
    stream.pendingTimer = undefined
  }

  private recallFailure(key: string): StreamFailure | undefined {
    const failure = this.recentFailures.get(key)
    this.recentFailures.delete(key)
    for (const [other, remembered] of this.recentFailures)
      if (remembered.retryAt <= Date.now()) this.recentFailures.delete(other)
    return failure && failure.retryAt > Date.now() ? failure : undefined
  }

  private retryDue(stream: Stream): boolean {
    return !stream.failure || Date.now() >= stream.failure.retryAt
  }

  private nextFailure(stream: Stream, message: string, code: number | undefined): StreamFailure {
    const attempt = (stream.failure?.attempt ?? 0) + 1
    return {
      message,
      code,
      attempt,
      retryAt: Date.now() + Math.min(60_000, 15_000 * 2 ** Math.min(attempt - 1, 2)),
    }
  }

  private streamFor(reqId: number): Stream | undefined {
    for (const stream of this.streams.values()) if (stream.reqId === reqId) return stream
    return undefined
  }

  private emptyBook(stream: DepthStream): MarketDepth {
    return {
      streamId: stream.key,
      symbol: stream.symbol,
      bids: [],
      asks: [],
      updatedAt: new Date().toISOString(),
    }
  }
}
