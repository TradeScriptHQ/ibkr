import type { GatewayConfig } from '../config.js'
import { RequestError } from '../ibkr/request-error.js'
import { type CredentialStore, RuntimeCredentialSchema } from './credential-store.js'
import {
  LeaseExchangeError,
  TradeScriptLeaseManager,
  type TradeScriptLeaseSnapshot,
} from './lease-manager.js'

export class Licensing {
  #config: GatewayConfig['tradescript']
  #leases: TradeScriptLeaseManager
  #saving = false
  #credentialReadFailed = false
  #subscribers = new Set<(snapshot: TradeScriptLeaseSnapshot) => void>()
  #unsubscribe: () => void
  constructor(
    config: GatewayConfig['tradescript'],
    private readonly store: CredentialStore,
  ) {
    try {
      const saved = store.read()
      const { credentialId: _id, credentialSecret: _secret, ...publicConfig } = config
      this.#config = saved
        ? { ...config, ...saved, runtimeCredentialsConfigured: true }
        : store.isSignedOut()
          ? { ...publicConfig, runtimeCredentialsConfigured: false }
          : config
    } catch {
      this.#credentialReadFailed = true
      const { credentialId: _id, credentialSecret: _secret, ...publicConfig } = config
      this.#config = { ...publicConfig, runtimeCredentialsConfigured: false }
    }
    this.#leases = new TradeScriptLeaseManager(this.#config)
    this.#unsubscribe = this.follow()
  }
  get config() {
    return this.#config
  }
  snapshot() {
    return this.#credentialReadFailed
      ? {
          state: 'error' as const,
          ready: false,
          message:
            'Saved SDK credentials could not be read. Reactivate SDK access to replace them.',
        }
      : this.#leases.snapshot()
  }
  renewIfDue() {
    this.#leases.renewIfDue()
  }
  getLease() {
    return this.#leases.getLease()
  }
  async retry() {
    if (this.#saving) throw new RequestError(409, 'SDK activation is already in progress.')
    this.#saving = true
    try {
      await this.#leases.refresh()
      return { configured: true, ready: true }
    } catch (error) {
      if (error instanceof LeaseExchangeError)
        throw new RequestError(error.statusCode, error.message, {
          source: 'tradescript-authorization',
          ...(error.failureReason ? { code: error.failureReason } : {}),
        })
      throw new RequestError(
        400,
        'SDK authorization is still unavailable. Check your internet connection, credentials and licence, then try again.',
      )
    } finally {
      this.#saving = false
    }
  }
  start() {
    this.#leases.start()
  }
  stop() {
    this.#unsubscribe()
    this.#leases.stop()
  }
  subscribe(listener: (snapshot: TradeScriptLeaseSnapshot) => void) {
    this.#subscribers.add(listener)
    listener(this.snapshot())
    return () => {
      this.#subscribers.delete(listener)
    }
  }
  private follow() {
    return this.#leases.subscribe(() => {
      for (const subscriber of this.#subscribers) subscriber(this.snapshot())
    })
  }
  clearCredentials() {
    if (this.#saving) throw new RequestError(409, 'SDK activation is already in progress.')
    this.store.clear()
    this.#unsubscribe()
    this.#leases.stop()
    const { credentialId: _id, credentialSecret: _secret, ...publicConfig } = this.#config
    this.#config = { ...publicConfig, runtimeCredentialsConfigured: false }
    this.#leases = new TradeScriptLeaseManager(this.#config)
    this.#credentialReadFailed = false
    this.#unsubscribe = this.follow()
    return { configured: false, ready: false }
  }
  async activate(input: unknown) {
    if (this.#saving) throw new RequestError(409, 'SDK activation is already in progress.')
    const parsed = RuntimeCredentialSchema.safeParse(input)
    if (!parsed.success) throw new RequestError(400, 'Enter your Client key and Secret.')
    this.#saving = true
    const config = { ...this.#config, ...parsed.data, runtimeCredentialsConfigured: true }
    const candidate = new TradeScriptLeaseManager(config)
    try {
      await candidate.getLease()
      this.store.write(parsed.data)
      this.#unsubscribe()
      this.#leases.stop()
      this.#config = config
      this.#leases = candidate
      this.#credentialReadFailed = false
      this.#unsubscribe = this.follow()
      return { configured: true, ready: true }
    } catch (error) {
      candidate.stop()
      if (error instanceof LeaseExchangeError)
        throw new RequestError(error.statusCode, error.message, {
          source: 'tradescript-authorization',
          ...(error.failureReason ? { code: error.failureReason } : {}),
        })
      throw new RequestError(
        400,
        'SDK activation failed. Check your credentials, internet connection, and licence for this application origin.',
      )
    } finally {
      this.#saving = false
    }
  }
}
