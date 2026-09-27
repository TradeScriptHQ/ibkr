import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadGatewayConfig } from '../src/config.js'
import { ConnectionManager } from '../src/connections/connection-manager.js'

const config = () => loadGatewayConfig({ NODE_ENV: 'test' })
const create = () => ({ start: vi.fn(), stop: vi.fn() })

describe('UI connection profiles', () => {
  it('switches to a custom live port and enforces read-only in either mode', async () => {
    const factory = vi.fn(create)
    const manager = new ConnectionManager(config(), factory)
    const old = manager.runtime
    const { settings, generation } = manager.snapshot()
    settings.active = 'live'
    settings.profiles.live.port = 4012
    settings.profiles.live.permission = 'manual'
    await manager.switch(settings, generation)
    expect(old.stop).toHaveBeenCalledOnce()
    expect(manager.runtime.start).toHaveBeenCalledOnce()
    expect(manager.config.ibkr).toMatchObject({
      executionEnvironment: 'live',
      port: 4012,
      tradingEnabled: true,
    })
    const next = manager.snapshot()
    next.settings.active = 'paper'
    next.settings.profiles.paper.permission = 'read-only'
    await manager.switch(next.settings, next.generation)
    expect(manager.config.ibkr.tradingEnabled).toBe(false)
    await expect(manager.execute(generation, vi.fn())).rejects.toThrow('connection changed')
  })

  it('finishes an in-flight operation before replacing its session and rejects new operations while switching', async () => {
    const manager = new ConnectionManager(config(), create)
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
    const switching = manager.switch(snapshot.settings, snapshot.generation)
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
      const manager = new ConnectionManager(config(), create, path)
      const { settings, generation } = manager.snapshot()
      settings.profiles.paper.port = 4051
      await manager.switch(settings, generation)
      expect(JSON.parse(readFileSync(path, 'utf8')).profiles.paper.port).toBe(4051)
      expect(new ConnectionManager(config(), create, path).config.ibkr.port).toBe(4051)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

it('enables agents on either mode only with the selected profile limits', async () => {
  const manager = new ConnectionManager(config(), create)
  const snapshot = manager.snapshot()
  snapshot.settings.active = 'live'
  snapshot.settings.profiles.live.permission = 'agent'
  await expect(manager.switch(snapshot.settings, snapshot.generation)).rejects.toThrow(
    'agent limits',
  )
  expect(manager.snapshot().generation).toBe(snapshot.generation)
  snapshot.settings.profiles.live.allowedAccountIds = ['U-test']
  snapshot.settings.profiles.live.limits = {
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
  await manager.switch(snapshot.settings, snapshot.generation)
  expect(manager.config.agents.enabled).toBe(true)
  expect(manager.config.agents.riskLimits).toEqual(snapshot.settings.profiles.live.limits)
})

it('keeps the current session when replacement construction fails', async () => {
  let rejectReplacement = false
  const manager = new ConnectionManager(config(), () => {
    if (rejectReplacement) throw new Error('Construction failed')
    return create()
  })
  const original = manager.runtime
  const snapshot = manager.snapshot()
  rejectReplacement = true
  await expect(manager.switch(snapshot.settings, snapshot.generation)).rejects.toThrow(
    'Construction failed',
  )
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
