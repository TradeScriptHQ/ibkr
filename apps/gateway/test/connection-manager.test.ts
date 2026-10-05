import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { ConnectionManager } from '../src/connections/connection-manager.js'

const config = () => loadGatewayConfig({ NODE_ENV: 'test' })
const create = () => ({ start: vi.fn(), stop: vi.fn() })
const discover = async (_host: string, port: number) => [
  port === 4012 || port === 7496 ? 'U-test' : 'DU-test',
]
const limits = {
  maxOrderQuantity: 100,
  maxOrderNotional: 1000,
  maxPositionQuantity: 100,
  maxPositionNotional: 1000,
  maxDailyLoss: 100,
  maxOrdersPerMinute: 10,
  maxEstimatedSlippageBps: 10,
  maxMarketDataAgeMs: 1000,
  maxLeverage: 2,
  maxUnprotectedPositionQuantity: 100,
}
const agentConfig = () => {
  const initial = config()
  return {
    ...initial,
    ibkr: { ...initial.ibkr, allowedAccountIds: ['DU-test'] },
    agents: { ...initial.agents, riskLimits: limits },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('tests the current connection through its runtime while managed accounts are still starting', async () => {
  const accounts = deferred<readonly string[]>()
  const runtime = { ...create(), testConnection: vi.fn(() => accounts.promise) }
  const discover = vi.fn().mockResolvedValue(['DU-probe'])
  const manager = new ConnectionManager(config(), () => runtime, undefined, discover)
  const snapshot = manager.snapshot()
  const testing = manager.test(snapshot.settings, snapshot.generation)
  try {
    expect(runtime.testConnection).toHaveBeenCalledOnce()
    expect(discover).not.toHaveBeenCalled()
    accounts.resolve(['DU-owner'])
    await expect(testing).resolves.toMatchObject({ accounts: ['DU-owner'] })
    expect(runtime.stop).not.toHaveBeenCalled()
  } finally {
    accounts.resolve(['DU-owner'])
    await Promise.allSettled([testing])
  }
})

it('deduplicates concurrent tests of the current connection into one owner wait and proof', async () => {
  const accounts = deferred<readonly string[]>()
  const runtime = { ...create(), testConnection: vi.fn(() => accounts.promise) }
  const discover = vi.fn().mockResolvedValue(['DU-probe'])
  const manager = new ConnectionManager(config(), () => runtime, undefined, discover)
  const snapshot = manager.snapshot()
  const first = manager.test(snapshot.settings, snapshot.generation)
  const second = manager.test(structuredClone(snapshot.settings), snapshot.generation)
  try {
    expect(runtime.testConnection).toHaveBeenCalledOnce()
    expect(discover).not.toHaveBeenCalled()
    accounts.resolve(['DU-owner'])
    expect(await first).toEqual(await second)
  } finally {
    accounts.resolve(['DU-owner'])
    await Promise.allSettled([first, second])
  }
})

it('deduplicates a changed endpoint probe and rejects a different test until it finishes', async () => {
  const accounts = deferred<string[]>()
  const discover = vi.fn(() => accounts.promise)
  const runtime = { ...create(), testConnection: vi.fn() }
  const manager = new ConnectionManager(config(), () => runtime, undefined, discover)
  const snapshot = manager.snapshot()
  snapshot.settings.profiles.paper.clientId += 1
  const first = manager.test(snapshot.settings, snapshot.generation)
  const duplicate = manager.test(structuredClone(snapshot.settings), snapshot.generation)
  const other = structuredClone(snapshot.settings)
  other.profiles.paper.clientId += 1
  const overlapping = manager.test(other, snapshot.generation)
  // Attach the rejection assertion before completing the first asynchronous probe.
  const rejected = expect(overlapping).rejects.toMatchObject({ statusCode: 409 })
  try {
    expect(discover).toHaveBeenCalledOnce()
    expect(runtime.testConnection).not.toHaveBeenCalled()
    accounts.resolve(['DU-probe'])
    await rejected
    expect(await first).toEqual(await duplicate)
    const next = await manager.test(other, snapshot.generation)
    expect(next.accounts).toEqual(['DU-probe'])
    expect(discover).toHaveBeenCalledTimes(2)
  } finally {
    accounts.resolve(['DU-probe'])
    await Promise.allSettled([first, duplicate, rejected])
  }
})

it('waits for the old runtime socket to close before starting its replacement', async () => {
  const closing = deferred<void>()
  const original = {
    ...create(),
    testConnection: vi.fn().mockResolvedValue(['DU-owner']),
    stop: vi.fn(() => closing.promise),
  }
  const replacement = { ...create(), testConnection: vi.fn() }
  const factory = vi.fn().mockReturnValueOnce(original).mockReturnValueOnce(replacement)
  const manager = new ConnectionManager(
    config(),
    factory,
    undefined,
    vi.fn().mockResolvedValue(['DU-probe']),
  )
  const snapshot = manager.snapshot()
  const proof = await manager.test(snapshot.settings, snapshot.generation)
  const switching = manager.switch(snapshot.settings, snapshot.generation, proof.testId)
  try {
    await Promise.resolve()
    expect(original.stop).toHaveBeenCalledOnce()
    expect(replacement.start).not.toHaveBeenCalled()
    expect(manager.runtime).toBe(original)
    await expect(manager.execute(snapshot.generation, vi.fn())).rejects.toMatchObject({
      statusCode: 409,
    })
    closing.resolve()
    await switching
    expect(replacement.start).toHaveBeenCalledOnce()
    expect(manager.runtime).toBe(replacement)
  } finally {
    closing.resolve()
    await Promise.allSettled([switching])
  }
})

it('requires successful server test proof before replacing a user-applied profile', async () => {
  const factory = vi.fn(create)
  const manager = new ConnectionManager(config(), factory)
  const snapshot = manager.snapshot()
  const original = manager.runtime
  await expect(manager.switch(snapshot.settings, snapshot.generation)).rejects.toThrow(
    'Test this connection again',
  )
  expect(factory).toHaveBeenCalledTimes(1)
  expect(original.stop).not.toHaveBeenCalled()
  expect(manager.snapshot()).toEqual(snapshot)
})

it('invalidates prior successful proof when a new test of the same endpoint fails', async () => {
  const discover = vi
    .fn()
    .mockResolvedValueOnce(['DU-test'])
    .mockRejectedValueOnce(new Error('Offline'))
  const manager = new ConnectionManager(config(), create, undefined, discover)
  const snapshot = manager.snapshot()
  const proof = await manager.test(snapshot.settings, snapshot.generation)
  await expect(manager.test(snapshot.settings, snapshot.generation)).rejects.toThrow('Offline')
  await expect(
    manager.switch(snapshot.settings, snapshot.generation, proof.testId),
  ).rejects.toThrow('Test this connection again')
})

it.each(['active', 'clientId', 'connectionType'] as const)(
  'binds test proof to the unchanged %s',
  async (field) => {
    const manager = new ConnectionManager(
      config(),
      create,
      undefined,
      vi.fn().mockResolvedValue(['DU-test']),
    )
    const snapshot = manager.snapshot()
    const proof = await manager.test(snapshot.settings, snapshot.generation)
    if (field === 'active') snapshot.settings.active = 'live'
    else if (field === 'clientId') snapshot.settings.profiles.paper.clientId += 1
    else snapshot.settings.profiles.paper.connectionType = 'ib-gateway'
    await expect(
      manager.switch(snapshot.settings, snapshot.generation, proof.testId),
    ).rejects.toThrow('Test this connection again')
  },
)

describe('UI connection profiles', () => {
  it('initializes Gateway profiles from the configured connection type', () => {
    const manager = new ConnectionManager(
      loadGatewayConfig({ NODE_ENV: 'test', IBKR_CONNECTION_TYPE: 'ib-gateway' }),
      create,
    )
    expect(manager.snapshot().settings.profiles.paper).toMatchObject({
      connectionType: 'ib-gateway',
      port: 4002,
    })
    expect(manager.snapshot().settings.profiles.live).toMatchObject({
      connectionType: 'ib-gateway',
      port: 4001,
    })
  })

  it('switches to a custom live port and keeps manual trading available in either mode', async () => {
    const factory = vi.fn(create)
    const manager = new ConnectionManager(config(), factory, undefined, discover)
    const old = manager.runtime
    const { settings, generation } = manager.snapshot()
    settings.active = 'live'
    settings.profiles.live.port = 4012
    settings.profiles.live.agentTradingEnabled = false
    const liveTest = await manager.test(settings, generation)
    await manager.switch(settings, generation, liveTest.testId)
    expect(old.stop).toHaveBeenCalledOnce()
    expect(manager.runtime.start).toHaveBeenCalledOnce()
    expect(manager.config.ibkr).toMatchObject({
      executionEnvironment: 'live',
      port: 4012,
      tradingEnabled: true,
    })
    const next = manager.snapshot()
    next.settings.active = 'paper'
    next.settings.profiles.paper.agentTradingEnabled = false
    const paperTest = await manager.test(next.settings, next.generation)
    await manager.switch(next.settings, next.generation, paperTest.testId)
    expect(manager.config.ibkr.tradingEnabled).toBe(true)
    expect(manager.config.agents.enabled).toBe(false)
    await expect(manager.execute(generation, vi.fn())).rejects.toThrow('connection changed')
  })

  it('finishes an in-flight operation before replacing its session and rejects new operations while switching', async () => {
    const manager = new ConnectionManager(config(), create, undefined, discover)
    let finish!: () => void
    const operation = manager.execute(
      manager.snapshot().generation,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await Promise.resolve()
    const old = manager.runtime
    const snapshot = manager.snapshot()
    const proof = await manager.test(snapshot.settings, snapshot.generation)
    const switching = manager.switch(snapshot.settings, snapshot.generation, proof.testId)
    await expect(manager.execute(snapshot.generation, vi.fn())).rejects.toThrow(
      'connection changed',
    )
    expect(old.stop).not.toHaveBeenCalled()
    finish()
    await operation
    await switching
    expect(old.stop).toHaveBeenCalledOnce()
  })

  it('persists profiles across launches without changing environment files', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'connection-profiles-'))
    try {
      const path = join(folder, 'settings.json')
      const manager = new ConnectionManager(config(), create, path, discover)
      const { settings, generation } = manager.snapshot()
      settings.profiles.paper.connectionType = 'ib-gateway'
      settings.profiles.paper.port = 4051
      const proof = await manager.test(settings, generation)
      await manager.switch(settings, generation, proof.testId)
      expect(JSON.parse(readFileSync(path, 'utf8')).profiles.paper.port).toBe(4051)
      expect(JSON.parse(readFileSync(path, 'utf8')).profiles.paper.connectionType).toBe(
        'ib-gateway',
      )
      expect(new ConnectionManager(config(), create, path).config.ibkr).toMatchObject({
        connectionType: 'ib-gateway',
        port: 4051,
      })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('migrates legacy saved profiles and preserves their exact advanced ports', () => {
    const folder = mkdtempSync(join(tmpdir(), 'connection-profiles-'))
    try {
      const path = join(folder, 'settings.json')
      writeFileSync(
        path,
        JSON.stringify({
          active: 'paper',
          profiles: {
            paper: { port: 4002, clientId: 7, permission: 'manual', allowedAccountIds: [] },
            live: { port: 4012, clientId: 8, permission: 'read-only', allowedAccountIds: [] },
          },
        }),
        { mode: 0o600 },
      )
      const manager = new ConnectionManager(config(), create, path)
      expect(manager.snapshot().settings.profiles.paper).toMatchObject({
        connectionType: 'ib-gateway',
        port: 4002,
        clientId: 7,
        agentTradingEnabled: false,
      })
      expect(manager.snapshot().settings.profiles.live).toMatchObject({
        connectionType: 'tws',
        port: 4012,
        clientId: 8,
        agentTradingEnabled: false,
      })
      expect(manager.snapshot().settings.profiles.paper).not.toHaveProperty('permission')
      expect(manager.snapshot().settings.profiles.live).not.toHaveProperty('permission')
      expect(manager.config.ibkr.connectionType).toBe('ib-gateway')
      expect(manager.config.ibkr.tradingEnabled).toBe(true)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

it('enables agents on the selected mode only with profile limits', async () => {
  const manager = new ConnectionManager(config(), create, undefined, discover)
  const snapshot = manager.snapshot()
  snapshot.settings.active = 'live'
  const proof = await manager.test(snapshot.settings, snapshot.generation)
  const switched = await manager.switch(snapshot.settings, snapshot.generation, proof.testId)
  await expect(manager.setAgentTrading(true, switched.generation)).rejects.toThrow('agent limits')
  expect(manager.snapshot().generation).toBe(switched.generation)
  await manager.setAgentTrading(true, switched.generation, limits)
  expect(manager.config.agents.enabled).toBe(true)
  expect(manager.config.agents.riskLimits).toEqual(limits)
  expect(manager.snapshot().settings.profiles.paper.agentTradingEnabled).toBe(false)
  expect(manager.snapshot().settings.profiles.live.allowedAccountIds).toEqual(['U-test'])
})

describe('agent trading toggle', () => {
  it('keeps legacy agent profiles without configured limits disabled on startup', () => {
    const folder = mkdtempSync(join(tmpdir(), 'connection-agent-toggle-'))
    try {
      const path = join(folder, 'settings.json')
      writeFileSync(
        path,
        JSON.stringify({
          active: 'paper',
          profiles: {
            paper: {
              port: 4002,
              clientId: 7,
              permission: 'agent',
              allowedAccountIds: ['DU-test'],
            },
            live: { port: 4001, clientId: 7, permission: 'read-only', allowedAccountIds: [] },
          },
        }),
        { mode: 0o600 },
      )
      const manager = new ConnectionManager(config(), create, path)
      expect(manager.snapshot().settings.profiles.paper.agentTradingEnabled).toBe(false)
      expect(manager.config.agents.enabled).toBe(false)
      expect(manager.config.ibkr.tradingEnabled).toBe(true)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it.each(['paper', 'live'] as const)(
    'keeps manual %s trading enabled when legacy environment flags are off',
    (mode) => {
      const initial = config()
      const manager = new ConnectionManager(
        {
          ...initial,
          ibkr: {
            ...initial.ibkr,
            executionEnvironment: mode,
            tradingEnabled: false,
            liveOrdersEnabled: false,
          },
        },
        create,
      )
      expect(manager.config.ibkr.tradingEnabled).toBe(true)
      expect(manager.config.ibkr.liveOrdersEnabled).toBe(true)
      expect(manager.config.agents.enabled).toBe(false)
    },
  )

  it('persists only the active profile toggle without reconnecting or changing generation', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'connection-agent-toggle-'))
    try {
      const path = join(folder, 'settings.json')
      const factory = vi.fn(create)
      const manager = new ConnectionManager(agentConfig(), factory, path)
      const original = manager.runtime
      const snapshot = manager.snapshot()
      expect(snapshot.agentTradingRevision).toBe(0)
      writeFileSync(`${path}.tmp`, 'old temporary file', { mode: 0o644 })
      const enabled = await manager.setAgentTrading(
        true,
        snapshot.generation,
        undefined,
        snapshot.agentTradingRevision,
      )
      expect(enabled.generation).toBe(snapshot.generation)
      expect(enabled.agentTradingRevision).toBe(1)
      expect(manager.runtime).toBe(original)
      expect(factory).toHaveBeenCalledOnce()
      expect(original.stop).not.toHaveBeenCalled()
      expect(original.start).not.toHaveBeenCalled()
      expect(enabled.settings.profiles.paper.agentTradingEnabled).toBe(true)
      expect(enabled.settings.profiles.live).toEqual(snapshot.settings.profiles.live)
      expect(manager.config.agents.enabled).toBe(true)
      expect(manager.config.ibkr.tradingEnabled).toBe(true)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      expect(saved.profiles.paper.agentTradingEnabled).toBe(true)
      expect(saved.profiles.paper).not.toHaveProperty('permission')
      expect(new ConnectionManager(config(), create, path).config.agents.enabled).toBe(true)

      const disabled = await manager.setAgentTrading(
        false,
        snapshot.generation,
        undefined,
        enabled.agentTradingRevision,
      )
      expect(disabled.generation).toBe(snapshot.generation)
      expect(disabled.agentTradingRevision).toBe(2)
      expect(disabled.settings.profiles.paper.limits).toEqual(limits)
      expect(manager.config.agents.enabled).toBe(false)
      expect(manager.config.ibkr.tradingEnabled).toBe(true)
      expect(manager.runtime).toBe(original)
      expect(JSON.parse(readFileSync(path, 'utf8')).profiles.paper.agentTradingEnabled).toBe(false)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('saves edited limits while agents are off and uses them on the next enable', async () => {
    const manager = new ConnectionManager(agentConfig(), create)
    const snapshot = manager.snapshot()
    const editedLimits = { ...limits, maxOrderQuantity: 5 }
    await manager.setAgentTrading(false, snapshot.generation, editedLimits)
    expect(manager.config.agents.enabled).toBe(false)
    expect(manager.snapshot().settings.profiles.paper.limits).toEqual(editedLimits)
    await manager.setAgentTrading(true, snapshot.generation)
    expect(manager.config.agents).toMatchObject({ enabled: true, riskLimits: editedLimits })
  })

  it('persists explicit null quantity caps without replacing the broker runtime', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ibkr-null-quantity-limits-'))
    const path = join(folder, 'connections.json')
    const factory = vi.fn(create)
    const manager = new ConnectionManager(agentConfig(), factory, path)
    const snapshot = manager.snapshot()
    const original = manager.runtime
    const valueBasedLimits = {
      ...limits,
      maxOrderQuantity: null,
      maxPositionQuantity: null,
      maxUnprotectedPositionQuantity: null,
    }
    try {
      const enabled = await manager.setAgentTrading(
        true,
        snapshot.generation,
        valueBasedLimits,
        snapshot.agentTradingRevision,
      )
      expect(enabled.agentTradingRevision).toBe(1)
      expect(enabled.generation).toBe(snapshot.generation)
      expect(enabled.settings.profiles.paper.limits).toEqual(valueBasedLimits)
      expect(manager.config.agents).toMatchObject({
        enabled: true,
        riskLimits: valueBasedLimits,
      })
      expect(manager.runtime).toBe(original)
      expect(factory).toHaveBeenCalledOnce()
      expect(original.start).not.toHaveBeenCalled()
      expect(original.stop).not.toHaveBeenCalled()
      const reloaded = new ConnectionManager(config(), create, path)
      expect(reloaded.snapshot().settings.profiles.paper.limits).toEqual(valueBasedLimits)
      expect(reloaded.config.agents).toMatchObject({
        enabled: true,
        riskLimits: valueBasedLimits,
      })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('rejects a stale agent revision after another client edits the toggle', async () => {
    const factory = vi.fn(create)
    const manager = new ConnectionManager(agentConfig(), factory)
    const stale = manager.snapshot()
    const original = manager.runtime
    const editedLimits = { ...limits, maxOrderQuantity: 5 }
    const current = await manager.setAgentTrading(
      true,
      stale.generation,
      editedLimits,
      stale.agentTradingRevision,
    )
    await expect(
      manager.setAgentTrading(false, stale.generation, limits, stale.agentTradingRevision),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(manager.snapshot()).toEqual(current)
    expect(manager.config.agents).toMatchObject({ enabled: true, riskLimits: editedLimits })
    expect(manager.runtime).toBe(original)
    expect(factory).toHaveBeenCalledOnce()
    expect(original.start).not.toHaveBeenCalled()
    expect(original.stop).not.toHaveBeenCalled()
    const disabled = await manager.setAgentTrading(
      false,
      current.generation,
      undefined,
      current.agentTradingRevision,
    )
    expect(disabled.agentTradingRevision).toBe(2)
    expect(disabled.generation).toBe(stale.generation)
  })

  it('rejects a stale generation without changing the active settings or runtime', async () => {
    const factory = vi.fn(create)
    const manager = new ConnectionManager(agentConfig(), factory)
    const snapshot = manager.snapshot()
    await expect(manager.setAgentTrading(true, 'stale-session', limits)).rejects.toThrow(
      'Connection settings changed',
    )
    expect(manager.snapshot()).toEqual(snapshot)
    expect(manager.config.agents.enabled).toBe(false)
    expect(factory).toHaveBeenCalledOnce()
  })

  it.each(['accounts', 'limits'] as const)(
    'fails closed when agent %s are missing',
    async (missing) => {
      const initial = agentConfig()
      const manager = new ConnectionManager(
        {
          ...initial,
          ibkr: {
            ...initial.ibkr,
            allowedAccountIds: missing === 'accounts' ? [] : ['DU-test'],
          },
          agents: {
            enabled: false,
            autonomyMode: 'paper-auto',
            ...(missing === 'limits' ? {} : { riskLimits: limits }),
          },
        },
        create,
      )
      const snapshot = manager.snapshot()
      await expect(manager.setAgentTrading(true, snapshot.generation)).rejects.toThrow(
        'requires selected accounts and agent limits',
      )
      expect(manager.snapshot()).toEqual(snapshot)
      expect(manager.config.agents.enabled).toBe(false)
      expect(manager.config.ibkr.tradingEnabled).toBe(true)
      await expect(manager.execute(snapshot.generation, () => 'manual')).resolves.toBe('manual')
    },
  )

  it('rejects invalid edited limits without replacing the saved limits or enabling agents', async () => {
    const manager = new ConnectionManager(agentConfig(), create)
    const snapshot = manager.snapshot()
    await expect(
      manager.setAgentTrading(true, snapshot.generation, { ...limits, maxOrderQuantity: 0 }),
    ).rejects.toThrow()
    expect(manager.snapshot()).toEqual(snapshot)
    expect(manager.config.agents.enabled).toBe(false)
  })

  it('drains submitted operations and blocks operations and competing toggles until saved', async () => {
    const factory = vi.fn(create)
    const manager = new ConnectionManager(agentConfig(), factory)
    const snapshot = manager.snapshot()
    let finish!: () => void
    const operation = manager.execute(
      snapshot.generation,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await Promise.resolve()
    const toggling = manager.setAgentTrading(true, snapshot.generation)
    const blockedOperation = vi.fn()
    await expect(manager.execute(snapshot.generation, blockedOperation)).rejects.toThrow(
      'connection changed',
    )
    await expect(manager.setAgentTrading(false, snapshot.generation)).rejects.toThrow(
      'Connection settings changed',
    )
    expect(blockedOperation).not.toHaveBeenCalled()
    expect(manager.config.agents.enabled).toBe(false)
    finish()
    await operation
    await toggling
    expect(manager.config.agents.enabled).toBe(true)
    expect(manager.snapshot().generation).toBe(snapshot.generation)
    expect(factory).toHaveBeenCalledOnce()
    await expect(manager.execute(snapshot.generation, () => 'finished')).resolves.toBe('finished')
  })

  it('preserves the active profile and runtime when persistence fails and releases the lock', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'connection-agent-toggle-'))
    try {
      const path = join(folder, 'settings.json')
      const manager = new ConnectionManager(agentConfig(), create, path)
      const snapshot = manager.snapshot()
      const original = manager.runtime
      mkdirSync(path)
      await expect(manager.setAgentTrading(true, snapshot.generation)).rejects.toThrow()
      expect(manager.snapshot()).toEqual(snapshot)
      expect(manager.snapshot().agentTradingRevision).toBe(0)
      expect(manager.config.agents.enabled).toBe(false)
      expect(manager.runtime).toBe(original)
      expect(original.stop).not.toHaveBeenCalled()
      expect(original.start).not.toHaveBeenCalled()
      await expect(manager.execute(snapshot.generation, () => 'manual')).resolves.toBe('manual')
      rmSync(path, { recursive: true })
      await manager.setAgentTrading(true, snapshot.generation)
      expect(manager.config.agents.enabled).toBe(true)
      expect(manager.snapshot().agentTradingRevision).toBe(1)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('preserves a newer agent toggle and limits when an older connection draft is applied', async () => {
    const manager = new ConnectionManager(agentConfig(), create, undefined, discover)
    const draft = manager.snapshot()
    const proof = await manager.test(draft.settings, draft.generation)
    const editedLimits = { ...limits, maxOrderQuantity: 5 }
    await manager.setAgentTrading(true, draft.generation, editedLimits)
    await manager.switch(draft.settings, draft.generation, proof.testId)
    expect(manager.config.agents).toMatchObject({ enabled: true, riskLimits: editedLimits })
    expect(manager.snapshot().settings.profiles.paper).toMatchObject({
      agentTradingEnabled: true,
      limits: editedLimits,
    })
  })

  it('does not enable agents through editable connection drafts', async () => {
    const manager = new ConnectionManager(agentConfig(), create, undefined, discover)
    const draft = manager.snapshot()
    draft.settings.profiles.paper.agentTradingEnabled = true
    draft.settings.profiles.live.agentTradingEnabled = true
    const proof = await manager.test(draft.settings, draft.generation)
    await manager.switch(draft.settings, draft.generation, proof.testId)
    expect(manager.config.agents.enabled).toBe(false)
    expect(manager.snapshot().settings.profiles.paper.agentTradingEnabled).toBe(false)
    expect(manager.snapshot().settings.profiles.live.agentTradingEnabled).toBe(false)
  })
})

it('keeps the current session when replacement construction fails', async () => {
  let rejectReplacement = false
  const manager = new ConnectionManager(
    config(),
    () => {
      if (rejectReplacement) throw new Error('Construction failed')
      return create()
    },
    undefined,
    discover,
  )
  const original = manager.runtime
  const snapshot = manager.snapshot()
  const proof = await manager.test(snapshot.settings, snapshot.generation)
  rejectReplacement = true
  await expect(
    manager.switch(snapshot.settings, snapshot.generation, proof.testId),
  ).rejects.toThrow('Construction failed')
  expect(manager.runtime).toBe(original)
  expect(original.stop).not.toHaveBeenCalled()
  expect(manager.snapshot().generation).toBe(snapshot.generation)
})

it('discovers accounts without switching and applies server-discovered accounts', async () => {
  const discover = vi.fn().mockResolvedValue(['DU-one', 'DU-two'])
  const manager = new ConnectionManager(config(), create, undefined, discover)
  const original = manager.runtime
  const snapshot = manager.snapshot()
  const result = await manager.test(snapshot.settings, snapshot.generation)
  expect(result.accounts).toEqual(['DU-one', 'DU-two'])
  expect(original.stop).not.toHaveBeenCalled()
  snapshot.settings.profiles.paper.allowedAccountIds = ['untrusted-client-value']
  await manager.switch(snapshot.settings, snapshot.generation, result.testId)
  expect(manager.config.ibkr.allowedAccountIds).toEqual(['DU-one', 'DU-two'])
})

it('requires retesting an edited endpoint and preserves the current runtime after a failed test', async () => {
  const discover = vi.fn().mockResolvedValue(['DU-one'])
  const manager = new ConnectionManager(config(), create, undefined, discover)
  const snapshot = manager.snapshot()
  const original = manager.runtime
  const result = await manager.test(snapshot.settings, snapshot.generation)
  snapshot.settings.profiles.paper.port += 1
  await expect(
    manager.switch(snapshot.settings, snapshot.generation, result.testId),
  ).rejects.toThrow('Test this connection again')
  discover.mockRejectedValue(new Error('TWS unavailable'))
  await expect(manager.test(snapshot.settings, snapshot.generation)).rejects.toThrow(
    'TWS unavailable',
  )
  expect(original.stop).not.toHaveBeenCalled()
})

it('reuses managed accounts from the existing socket and rejects a mismatched mode', async () => {
  const discover = vi.fn()
  const manager = new ConnectionManager(
    config(),
    () => ({ ...create(), connectedAccounts: () => ['DU-one'] }),
    undefined,
    discover,
  )
  const snapshot = manager.snapshot()
  await expect(manager.test(snapshot.settings, snapshot.generation)).resolves.toMatchObject({
    accounts: ['DU-one'],
  })
  expect(discover).not.toHaveBeenCalled()
  snapshot.settings.active = 'live'
  snapshot.settings.profiles.live.port = snapshot.settings.profiles.paper.port
  await expect(manager.test(snapshot.settings, snapshot.generation)).rejects.toThrow(
    'does not match',
  )
})

it('retests a relabeled application using the same socket accounts without a duplicate-client probe', async () => {
  const discover = vi.fn()
  const manager = new ConnectionManager(
    config(),
    () => ({ ...create(), connectedAccounts: () => ['DU-current'] }),
    undefined,
    discover,
  )
  const snapshot = manager.snapshot()
  const previousProof = await manager.test(snapshot.settings, snapshot.generation)
  snapshot.settings.profiles.paper.connectionType = 'ib-gateway'
  await expect(
    manager.switch(snapshot.settings, snapshot.generation, previousProof.testId),
  ).rejects.toThrow('Test this connection again')
  const proof = await manager.test(snapshot.settings, snapshot.generation)
  expect(discover).not.toHaveBeenCalled()
  await manager.switch(snapshot.settings, snapshot.generation, proof.testId)
  expect(manager.config.ibkr).toMatchObject({
    connectionType: 'ib-gateway',
    port: 7497,
    allowedAccountIds: ['DU-current'],
  })
})
