import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type ConnectionSettings,
  ConnectionSettingsSchema,
  type ConnectionSnapshot,
} from '@ibkr-terminal/contracts'
import type { GatewayConfig } from '../config.js'
import { RequestError } from '../ibkr/request-error.js'
import { discoverTwsAccounts } from './test-connection.js'

export interface ConnectionRuntime {
  connectedAccounts?(): readonly string[] | undefined
  start(): void
  stop(): void
}

/** One active broker session. Switching waits for submitted operations to finish. */
export class ConnectionManager<T extends ConnectionRuntime> {
  #settings: ConnectionSettings
  #generation = randomUUID()
  #runtime: T
  #switching = false
  #test?: { id: string; key: string; accounts: string[] }
  #operations = new Set<Promise<unknown>>()

  constructor(
    private readonly initial: GatewayConfig,
    private readonly create: (config: GatewayConfig) => T,
    private readonly settingsPath?: string,
    private readonly discover = discoverTwsAccounts,
  ) {
    this.#settings = {
      active: initial.ibkr.executionEnvironment,
      profiles: {
        paper: {
          ...(initial.agents.riskLimits ? { limits: initial.agents.riskLimits } : {}),
          allowedAccountIds: [...initial.ibkr.allowedAccountIds],
          port: 7497,
          clientId: initial.ibkr.clientId,
          permission: initial.agents.enabled ? 'agent' : 'manual',
        },
        live: {
          ...(initial.agents.riskLimits ? { limits: initial.agents.riskLimits } : {}),
          allowedAccountIds: [...initial.ibkr.allowedAccountIds],
          port: 7496,
          clientId: initial.ibkr.clientId,
          permission: initial.ibkr.liveOrdersEnabled ? 'manual' : 'read-only',
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
        enabled: profile.permission === 'agent',
        ...(profile.limits ? { riskLimits: profile.limits } : {}),
      },
      ibkr: {
        ...this.initial.ibkr,
        executionEnvironment: mode,
        port: profile.port,
        allowedAccountIds: profile.allowedAccountIds,
        tradingEnabled: profile.permission !== 'read-only',
        clientId: profile.clientId,
        liveOrdersEnabled: profile.permission !== 'read-only',
      },
    }
  }
  snapshot(): ConnectionSnapshot {
    return { generation: this.#generation, settings: structuredClone(this.#settings) }
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
  private testKey(settings: ConnectionSettings): string {
    const profile = settings.profiles[settings.active]
    return JSON.stringify([this.#generation, settings.active, profile.port, profile.clientId])
  }
  async test(settings: ConnectionSettings, generation: string) {
    if (this.#switching || generation !== this.#generation)
      throw new RequestError(409, 'Connection settings changed. Try again.')
    const profile = settings.profiles[settings.active]
    const current = this.#settings.profiles[this.#settings.active]
    const connected =
      current.port === profile.port && current.clientId === profile.clientId
        ? this.#runtime.connectedAccounts?.()
        : undefined
    const accounts = [
      ...(connected?.length
        ? connected
        : await this.discover(this.initial.ibkr.host, profile.port, profile.clientId)),
    ]
    if (!accounts.length) throw new RequestError(400, 'TWS returned no accounts.')
    if (accounts.some((account) => account.startsWith('DU') !== (settings.active === 'paper')))
      throw new RequestError(400, 'The TWS account does not match the selected Live or Paper mode.')
    if (generation !== this.#generation)
      throw new RequestError(409, 'Connection changed during the test. Try again.')
    this.#test = { id: randomUUID(), key: this.testKey(settings), accounts }
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
      const profile = next.profiles[next.active]
      if (testId !== undefined) {
        if (this.#test?.id !== testId || this.#test.key !== this.testKey(next))
          throw new RequestError(409, 'Test this connection again before applying.')
        profile.allowedAccountIds = [...this.#test.accounts]
      }
      if (
        profile.permission === 'agent' &&
        (!profile.limits || profile.allowedAccountIds.length === 0)
      ) {
        throw new RequestError(400, 'Agent trading requires selected accounts and agent limits.')
      }
      const runtime = this.create(this.configuration(next))
      if (this.settingsPath) {
        mkdirSync(dirname(this.settingsPath), { recursive: true, mode: 0o700 })
        writeFileSync(`${this.settingsPath}.tmp`, JSON.stringify(next), { mode: 0o600 })
        renameSync(`${this.settingsPath}.tmp`, this.settingsPath)
      }
      this.#runtime.stop()
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
