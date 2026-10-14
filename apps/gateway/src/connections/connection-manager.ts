import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ConnectionProfileSchema,
  type ConnectionSettings,
  ConnectionSettingsSchema,
  type ConnectionSnapshot,
  connectionTypeLabel,
  defaultConnectionPort,
  inferConnectionType,
} from '@ibkr-terminal/contracts'
import type { GatewayConfig } from '../config.js'
import { RequestError } from '../ibkr/request-error.js'
import { accountsMatchExecutionEnvironment } from './account-environment.js'
import { discoverTwsAccounts } from './test-connection.js'

export interface ConnectionRuntime {
  connectedAccounts?(): readonly string[] | undefined
  testConnection?(): Promise<readonly string[]>
  retryConnection?(): void
  start(): void
  stop(): void | Promise<void>
}

/** One active broker session. Switching waits for submitted operations to finish. */
export class ConnectionManager<T extends ConnectionRuntime> {
  #settings: ConnectionSettings
  #generation = randomUUID()
  #agentTradingRevision = 0
  #runtime: T
  #switching = false
  #test: { id: string; key: string; accounts: string[] } | undefined
  #pendingTest: { key: string; result: Promise<{ testId: string; accounts: string[] }> } | undefined
  #operations = new Set<Promise<unknown>>()

  constructor(
    private readonly initial: GatewayConfig,
    private readonly create: (config: GatewayConfig) => T,
    private readonly settingsPath?: string,
    private readonly discover = discoverTwsAccounts,
  ) {
    const connectionType = initial.ibkr.connectionType ?? inferConnectionType(initial.ibkr.port)
    this.#settings = {
      active: initial.ibkr.executionEnvironment,
      profiles: {
        paper: {
          connectionType,
          ...(initial.agents.riskLimits ? { limits: initial.agents.riskLimits } : {}),
          allowedAccountIds: [...initial.ibkr.allowedAccountIds],
          port: defaultConnectionPort('paper', connectionType),
          clientId: initial.ibkr.clientId,
          agentTradingEnabled: initial.agents.enabled,
        },
        live: {
          connectionType,
          ...(initial.agents.riskLimits ? { limits: initial.agents.riskLimits } : {}),
          allowedAccountIds: [...initial.ibkr.allowedAccountIds],
          port: defaultConnectionPort('live', connectionType),
          clientId: initial.ibkr.clientId,
          agentTradingEnabled: false,
        },
      },
    }
    this.#settings.profiles[this.#settings.active].port = initial.ibkr.port
    if (settingsPath) {
      try {
        this.#settings = ConnectionSettingsSchema.parse(
          JSON.parse(readFileSync(settingsPath, 'utf8')),
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    for (const profile of Object.values(this.#settings.profiles)) {
      if (!profile.limits || profile.allowedAccountIds.length === 0)
        profile.agentTradingEnabled = false
    }
    this.#runtime = create(this.config)
  }

  get runtime(): T {
    return this.#runtime
  }
  get config(): GatewayConfig {
    return this.configuration(this.#settings)
  }
  private configuration(settings: ConnectionSettings): GatewayConfig {
    const mode = settings.active
    const profile = settings.profiles[mode]
    return {
      ...this.initial,
      agents: {
        autonomyMode: 'paper-auto',
        enabled:
          profile.agentTradingEnabled &&
          profile.limits !== undefined &&
          profile.allowedAccountIds.length > 0,
        ...(profile.limits ? { riskLimits: profile.limits } : {}),
      },
      ibkr: {
        ...this.initial.ibkr,
        executionEnvironment: mode,
        connectionType: profile.connectionType,
        port: profile.port,
        allowedAccountIds: profile.allowedAccountIds,
        tradingEnabled: true,
        clientId: profile.clientId,
        liveOrdersEnabled: true,
      },
    }
  }
  snapshot(): ConnectionSnapshot {
    return {
      generation: this.#generation,
      agentTradingRevision: this.#agentTradingRevision,
      settings: structuredClone(this.#settings),
    }
  }
  private persist(settings: ConnectionSettings): void {
    if (!this.settingsPath) return
    mkdirSync(dirname(this.settingsPath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.settingsPath}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(settings), { mode: 0o600 })
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, this.settingsPath)
  }
  async setAgentTrading(
    enabled: boolean,
    generation: string,
    limits?: ConnectionSettings['profiles']['paper']['limits'],
    expectedRevision?: number,
  ): Promise<ConnectionSnapshot> {
    if (this.#switching || generation !== this.#generation)
      throw new RequestError(409, 'Connection settings changed. Reload them and try again.')
    const parsedLimits = ConnectionProfileSchema.shape.limits.safeParse(limits)
    if (!parsedLimits.success) throw new RequestError(400, 'Invalid agent trading limits.')
    this.#switching = true
    try {
      await Promise.allSettled([...this.#operations])
      if (expectedRevision !== undefined && expectedRevision !== this.#agentTradingRevision)
        throw new RequestError(409, 'Agent trading settings changed. Reload them and try again.')
      const next = structuredClone(this.#settings)
      const profile = next.profiles[next.active]
      if (limits !== undefined) profile.limits = parsedLimits.data
      if (enabled && (!profile.limits || profile.allowedAccountIds.length === 0))
        throw new RequestError(400, 'Agent trading requires selected accounts and agent limits.')
      profile.agentTradingEnabled = enabled
      this.persist(next)
      this.#settings = next
      this.#agentTradingRevision += 1
      return this.snapshot()
    } finally {
      this.#switching = false
    }
  }
  async execute<R>(generation: string | undefined, execute: () => R | Promise<R>): Promise<R> {
    if (this.#switching || generation !== this.#generation) {
      throw new RequestError(
        409,
        'The connection changed. Reopen the ticket in the current session.',
      )
    }
    const operation = Promise.resolve().then(execute)
    this.#operations.add(operation)
    try {
      return await operation
    } finally {
      this.#operations.delete(operation)
    }
  }

  retryConnection(generation: string): Promise<ConnectionSnapshot> {
    return this.execute(generation, () => {
      if (!this.#runtime.retryConnection)
        throw new RequestError(503, 'Connection retries are unavailable.')
      this.#runtime.retryConnection()
      return this.snapshot()
    })
  }
  private testKey(settings: ConnectionSettings): string {
    const profile = settings.profiles[settings.active]
    return JSON.stringify([
      this.#generation,
      settings.active,
      profile.connectionType,
      profile.port,
      profile.clientId,
    ])
  }
  /** Concurrent tests of one endpoint share a single probe; a different endpoint waits its turn. */
  async test(settings: ConnectionSettings, generation: string) {
    if (this.#switching || generation !== this.#generation)
      throw new RequestError(409, 'Connection settings changed. Try again.')
    const key = this.testKey(settings)
    if (this.#pendingTest) {
      if (this.#pendingTest.key === key) return this.#pendingTest.result
      throw new RequestError(409, 'Another connection test is running. Try again when it finishes.')
    }
    const result = this.runTest(settings, generation, key)
    const pending = { key, result }
    this.#pendingTest = pending
    try {
      return await result
    } finally {
      if (this.#pendingTest === pending) this.#pendingTest = undefined
    }
  }
  private async runTest(settings: ConnectionSettings, generation: string, key: string) {
    this.#test = undefined
    const profile = settings.profiles[settings.active]
    const current = this.#settings.profiles[this.#settings.active]
    const sameSocket = current.port === profile.port && current.clientId === profile.clientId
    const runtime = this.#runtime
    const connected = sameSocket ? runtime.connectedAccounts?.() : undefined
    const accounts = [
      ...(connected?.length
        ? connected
        : sameSocket && runtime.testConnection
          ? await runtime.testConnection()
          : await this.discover(
              this.initial.ibkr.host,
              profile.port,
              profile.clientId,
              profile.connectionType,
            )),
    ]
    const label = connectionTypeLabel(profile.connectionType)
    if (!accounts.length) throw new RequestError(400, `${label} returned no accounts.`)
    if (!accountsMatchExecutionEnvironment(accounts, settings.active))
      throw new RequestError(
        400,
        `The ${label} account does not match the selected Live or Paper mode.`,
      )
    if (generation !== this.#generation)
      throw new RequestError(409, 'Connection changed during the test. Try again.')
    this.#test = { id: randomUUID(), key, accounts }
    return { testId: this.#test.id, accounts }
  }
  async switch(
    settings: ConnectionSettings,
    generation: string,
    testId?: string,
  ): Promise<ConnectionSnapshot> {
    if (this.#switching || generation !== this.#generation)
      throw new RequestError(409, 'Connection settings changed. Reload them and try again.')
    this.#switching = true
    try {
      await Promise.allSettled([...this.#operations])
      const next = ConnectionSettingsSchema.parse(settings)
      for (const mode of ['paper', 'live'] as const) {
        const current = this.#settings.profiles[mode]
        next.profiles[mode].agentTradingEnabled = current.agentTradingEnabled
        next.profiles[mode].limits = structuredClone(current.limits)
      }
      const profile = next.profiles[next.active]
      if (!testId || this.#test?.id !== testId || this.#test.key !== this.testKey(next))
        throw new RequestError(409, 'Test this connection again before applying.')
      profile.allowedAccountIds = [...this.#test.accounts]
      if (
        profile.agentTradingEnabled &&
        (!profile.limits || profile.allowedAccountIds.length === 0)
      ) {
        throw new RequestError(400, 'Agent trading requires selected accounts and agent limits.')
      }
      const runtime = this.create(this.configuration(next))
      this.persist(next)
      // The replacement reuses the client ID, so the old socket must close first.
      await this.#runtime.stop()
      this.#settings = next
      this.#generation = randomUUID()
      this.#runtime = runtime
      this.#runtime.start()
      return this.snapshot()
    } finally {
      this.#switching = false
    }
  }
}
