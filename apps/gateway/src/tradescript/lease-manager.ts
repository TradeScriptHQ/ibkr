import { z } from 'zod'
import type { GatewayConfig } from '../config.js'

const LeaseResponseSchema = z.object({
  lease: z.string().min(64),
  leaseType: z.literal('TradeScript-Deployment-Lease'),
  expiresAt: z.iso.datetime(),
  expiresIn: z.number().int().positive(),
  renewAfter: z.iso.datetime(),
  renewAfterIn: z.number().int().positive(),
  catalogVersion: z.string().min(1),
  policy: z.record(z.string(), z.unknown()),
})

export interface TradeScriptLease {
  readonly lease: string
  readonly leaseType: 'TradeScript-Deployment-Lease'
  readonly sdkVersion: string
  readonly customerBuildFingerprint: string
  readonly expiresAt: string
  readonly renewAfter: string
}

export interface TradeScriptLeaseSnapshot {
  readonly state: 'unconfigured' | 'exchanging' | 'ready' | 'degraded' | 'error' | 'stopped'
  readonly ready: boolean
  readonly message: string
  readonly failure?: 'rejected' | 'unavailable'
  readonly expiresAt?: string
  readonly renewAfter?: string
}

type Subscriber = (snapshot: TradeScriptLeaseSnapshot) => void

class LeaseExchangeError extends Error {
  readonly retryable: boolean
  readonly rejected: boolean

  constructor(message: string, retryable: boolean, rejected = false) {
    super(message)
    this.name = 'LeaseExchangeError'
    this.retryable = retryable
    this.rejected = rejected
  }
}

export class TradeScriptLeaseManager {
  readonly #config: GatewayConfig['tradescript']
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #subscribers = new Set<Subscriber>()
  #state: TradeScriptLeaseSnapshot['state'] = 'unconfigured'
  #message = 'TradeScript runtime authorization is not configured.'
  #current: TradeScriptLease | undefined
  #activeExchange: Promise<TradeScriptLease> | undefined
  #timer: NodeJS.Timeout | undefined
  #stopped = false
  #retryAttempt = 0
  #failure: TradeScriptLeaseSnapshot['failure']

  constructor(
    config: GatewayConfig['tradescript'],
    options: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.#config = config
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
  }

  snapshot(): TradeScriptLeaseSnapshot {
    const ready = this.#current !== undefined && Date.parse(this.#current.expiresAt) > this.#now()
    return {
      state: this.#state,
      ready,
      message: this.#message,
      ...(this.#failure ? { failure: this.#failure } : {}),
      ...(this.#current === undefined
        ? {}
        : { expiresAt: this.#current.expiresAt, renewAfter: this.#current.renewAfter }),
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber)
    subscriber(this.snapshot())
    return () => this.#subscribers.delete(subscriber)
  }

  start(): void {
    if (this.#stopped || !this.#config.runtimeCredentialsConfigured) return
    void this.refresh().catch(() => undefined)
  }

  /**
   * Starts a renewal whose timer was missed, e.g. while the computer slept. Failed
   * exchanges keep their own backoff or wait for the user, so they are not retried here.
   */
  renewIfDue(): void {
    if (
      this.#stopped ||
      this.#activeExchange !== undefined ||
      this.#failure !== undefined ||
      this.#current === undefined ||
      Date.parse(this.#current.renewAfter) > this.#now()
    )
      return
    void this.refresh().catch(() => undefined)
  }

  async getLease(): Promise<TradeScriptLease> {
    if (this.#stopped) throw new Error('TradeScript lease manager is stopped')
    if (!this.#config.runtimeCredentialsConfigured) {
      throw new Error('TradeScript runtime authorization is not configured')
    }
    if (this.#current !== undefined && Date.parse(this.#current.expiresAt) > this.#now()) {
      return this.#current
    }
    return this.refresh()
  }

  async refresh(): Promise<TradeScriptLease> {
    if (this.#activeExchange !== undefined) return this.#activeExchange
    this.#clearTimer()
    this.#activeExchange = this.#exchange()
    try {
      return await this.#activeExchange
    } finally {
      this.#activeExchange = undefined
    }
  }

  stop(): void {
    this.#stopped = true
    this.#clearTimer()
    this.#state = 'stopped'
    this.#message = 'TradeScript lease renewal is stopped.'
    this.#notify()
  }

  async #exchange(): Promise<TradeScriptLease> {
    const credentialId = this.#config.credentialId
    const credentialSecret = this.#config.credentialSecret
    const credentialExchangeUrl = this.#config.credentialExchangeUrl
    const sdkVersion = this.#config.sdkVersion
    const customerBuildFingerprint = this.#config.customerBuildFingerprint
    if (
      credentialId === undefined ||
      credentialSecret === undefined ||
      credentialExchangeUrl === undefined ||
      sdkVersion === undefined ||
      customerBuildFingerprint === undefined
    ) {
      throw new Error('TradeScript runtime authorization is incomplete')
    }

    this.#state = 'exchanging'
    this.#message = 'Exchanging the backend credential for a browser deployment lease.'
    this.#notify()

    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 15_000)
    try {
      const response = await this.#fetch(credentialExchangeUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${credentialId}:${credentialSecret}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sdkVersion,
          customerBuildFingerprint,
          requestedOrigin: this.#config.requestedOrigin,
        }),
        signal: abort.signal,
      })
      if (!response.ok) {
        throw new LeaseExchangeError(
          `TradeScript authorization rejected the lease exchange with status ${response.status}.`,
          response.status >= 500 || response.status === 408 || response.status === 429,
          response.status === 401 || response.status === 403,
        )
      }
      const parsed = LeaseResponseSchema.parse(await response.json())
      const expiresAt = Date.parse(parsed.expiresAt)
      const renewAfter = Date.parse(parsed.renewAfter)
      const now = this.#now()
      if (expiresAt <= now || renewAfter >= expiresAt) {
        throw new LeaseExchangeError('TradeScript returned an invalid lease lifetime.', false)
      }
      const lease: TradeScriptLease = {
        lease: parsed.lease,
        leaseType: parsed.leaseType,
        sdkVersion,
        customerBuildFingerprint,
        expiresAt: parsed.expiresAt,
        renewAfter: parsed.renewAfter,
      }
      this.#current = lease
      this.#retryAttempt = 0
      this.#failure = undefined
      this.#state = 'ready'
      this.#message = 'A valid TradeScript browser deployment lease is cached in memory.'
      this.#notify()
      this.#schedule(Math.max(1_000, renewAfter - now))
      return lease
    } catch (error) {
      this.#failure =
        error instanceof LeaseExchangeError && error.rejected ? 'rejected' : 'unavailable'
      const currentValid =
        this.#current !== undefined && Date.parse(this.#current.expiresAt) > this.#now()
      this.#state = currentValid ? 'degraded' : 'error'
      this.#message = currentValid
        ? 'TradeScript lease renewal failed; the current unexpired lease remains active.'
        : error instanceof LeaseExchangeError
          ? error.message
          : 'TradeScript lease exchange failed.'
      this.#notify()
      const retryable = !(error instanceof LeaseExchangeError) || error.retryable
      if (retryable && !this.#stopped) {
        const delay = Math.min(1_000 * 2 ** this.#retryAttempt, 60_000)
        this.#retryAttempt += 1
        this.#schedule(delay)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  #schedule(delayMs: number): void {
    this.#clearTimer()
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      if (!this.#stopped) void this.refresh().catch(() => undefined)
    }, delayMs)
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #notify(): void {
    const snapshot = this.snapshot()
    for (const subscriber of this.#subscribers) subscriber(snapshot)
  }
}
