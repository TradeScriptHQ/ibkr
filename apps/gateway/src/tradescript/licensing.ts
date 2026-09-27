import type { GatewayConfig } from '../config.js'
import { RequestError } from '../ibkr/request-error.js'
import { type CredentialStore, RuntimeCredentialSchema } from './credential-store.js'
import { TradeScriptLeaseManager, type TradeScriptLeaseSnapshot } from './lease-manager.js'

export class Licensing {
  #config: GatewayConfig['tradescript']
  #leases: TradeScriptLeaseManager
  #saving = false
  #subscribers = new Set<(snapshot: TradeScriptLeaseSnapshot) => void>()
  #unsubscribe: () => void
  constructor(
    config: GatewayConfig['tradescript'],
    private readonly store: CredentialStore,
  ) {
    const saved = store.read()
    this.#config = saved ? { ...config, ...saved, runtimeCredentialsConfigured: true } : config
    this.#leases = new TradeScriptLeaseManager(this.#config)
    this.#unsubscribe = this.follow()
  }
  get config() {
    return this.#config
  }
  snapshot() {
    return this.#leases.snapshot()
  }
  getLease() {
    return this.#leases.getLease()
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
    return this.#leases.subscribe((snapshot) => {
      for (const subscriber of this.#subscribers) subscriber(snapshot)
    })
  }
  async activate(input: unknown) {
    if (this.#saving) throw new RequestError(409, 'SDK activation is already in progress.')
    const parsed = RuntimeCredentialSchema.safeParse(input)
    if (!parsed.success)
      throw new RequestError(400, 'Enter the SDK credential ID and secret from Developer Console.')
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
      this.#unsubscribe = this.follow()
      return { configured: true, ready: true }
    } catch {
      candidate.stop()
      throw new RequestError(
        400,
        'SDK activation failed. Check your credentials, internet connection, and licence for this application origin.',
      )
    } finally {
      this.#saving = false
    }
  }
}
