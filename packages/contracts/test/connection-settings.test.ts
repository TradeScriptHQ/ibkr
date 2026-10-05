import { describe, expect, it } from 'vitest'
import {
  ConnectionProfileSchema,
  ConnectionSettingsSchema,
  ConnectionSnapshotSchema,
  connectionTypeLabel,
  defaultConnectionPort,
} from '../src/index.js'

describe('connection settings', () => {
  const valueBasedLimits = {
    maxOrderQuantity: null,
    maxOrderNotional: 1000,
    maxPositionQuantity: null,
    maxPositionNotional: 5000,
    maxGrossExposure: 10000,
    maxDailyLoss: 100,
    maxOrdersPerMinute: 5,
    maxEstimatedSlippageBps: 10,
    maxMarketDataAgeMs: 5000,
    maxLeverage: 1,
    maxUnprotectedPositionQuantity: null,
  }

  it('accepts explicitly unbounded quantity caps while retaining the value-based limits', () => {
    const profile = ConnectionProfileSchema.parse({
      port: 7497,
      clientId: 7,
      allowedAccountIds: [],
      limits: valueBasedLimits,
    })
    expect(profile.limits).toEqual(valueBasedLimits)
  })

  it('preserves saved numeric quantity caps', () => {
    const saved = {
      ...valueBasedLimits,
      maxOrderQuantity: 10,
      maxPositionQuantity: 20,
      maxUnprotectedPositionQuantity: 5,
    }
    const parsed = ConnectionProfileSchema.shape.limits.unwrap().parse(saved)
    expect(parsed).toEqual(saved)
  })

  it.each(['maxOrderNotional', 'maxPositionNotional', 'maxDailyLoss'] as const)(
    'requires a positive %s even when quantity caps are unbounded',
    (key) => {
      for (const invalid of [undefined, null, 0, -1]) {
        expect(
          ConnectionProfileSchema.shape.limits.unwrap().safeParse({
            ...valueBasedLimits,
            [key]: invalid,
          }).success,
        ).toBe(false)
      }
    },
  )

  it.each(['maxOrderQuantity', 'maxPositionQuantity', 'maxUnprotectedPositionQuantity'] as const)(
    'requires %s to be an explicit null or positive saved cap',
    (key) => {
      for (const invalid of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          ConnectionProfileSchema.shape.limits.unwrap().safeParse({
            ...valueBasedLimits,
            [key]: invalid,
          }).success,
        ).toBe(false)
      }
    },
  )

  it('accepts snapshots with an agent revision while preserving older snapshots', () => {
    const profile = { port: 7497, clientId: 7, allowedAccountIds: [] }
    const snapshot = {
      generation: 'session',
      settings: { active: 'paper', profiles: { paper: profile, live: profile } },
    }
    expect(ConnectionSnapshotSchema.parse(snapshot)).not.toHaveProperty('agentTradingRevision')
    expect(ConnectionSnapshotSchema.parse({ ...snapshot, agentTradingRevision: 2 })).toHaveProperty(
      'agentTradingRevision',
      2,
    )
  })

  it('defaults agent trading off without imposing a manual-trading permission', () => {
    const profile = ConnectionProfileSchema.parse({
      port: 7497,
      clientId: 7,
      allowedAccountIds: [],
    })
    expect(profile.agentTradingEnabled).toBe(false)
    expect(profile).not.toHaveProperty('permission')
  })

  it.each([
    ['read-only', false],
    ['manual', false],
    ['agent', true],
  ] as const)('migrates legacy %s permissions to agent trading %s', (permission, enabled) => {
    const profile = { port: 4002, clientId: 7, permission, allowedAccountIds: [] }
    const parsed = ConnectionSettingsSchema.parse({
      active: 'paper',
      profiles: { paper: profile, live: profile },
    })
    for (const migrated of Object.values(parsed.profiles)) {
      expect(migrated).toMatchObject({
        connectionType: 'ib-gateway',
        port: 4002,
        agentTradingEnabled: enabled,
      })
      expect(migrated).not.toHaveProperty('permission')
    }
    expect(profile.permission).toBe(permission)
    expect(profile).not.toHaveProperty('agentTradingEnabled')
  })

  it.each([
    ['agent', false],
    ['manual', true],
  ] as const)(
    'prefers the explicit agent toggle over legacy %s permission',
    (permission, enabled) => {
      const profile = {
        connectionType: 'tws',
        port: 4002,
        clientId: 7,
        permission,
        agentTradingEnabled: enabled,
        allowedAccountIds: [],
      }
      const parsed = ConnectionSettingsSchema.parse({
        active: 'paper',
        profiles: { paper: profile, live: profile },
      })
      expect(parsed.profiles.paper).toMatchObject({
        connectionType: 'tws',
        agentTradingEnabled: enabled,
      })
      expect(parsed.profiles.paper).not.toHaveProperty('permission')
    },
  )

  it.each([
    ['paper', 'tws', 7497],
    ['live', 'tws', 7496],
    ['paper', 'ib-gateway', 4002],
    ['live', 'ib-gateway', 4001],
  ] as const)('uses the default %s %s port', (mode, connectionType, port) => {
    expect(defaultConnectionPort(mode, connectionType)).toBe(port)
  })

  it.each([
    [4001, 'ib-gateway'],
    [4002, 'ib-gateway'],
    [7496, 'tws'],
    [7497, 'tws'],
    [4051, 'tws'],
  ])('migrates legacy port %s without changing it', (port, connectionType) => {
    const profile = { port, clientId: 7, permission: 'read-only', allowedAccountIds: [] }
    const parsed = ConnectionSettingsSchema.parse({
      active: 'paper',
      profiles: { paper: profile, live: profile },
    })
    expect(parsed.profiles.paper).toMatchObject({ connectionType, port })
    expect(parsed.profiles.live).toMatchObject({ connectionType, port })
  })

  it('keeps an explicit type when a manual port resembles another application default', () => {
    const profile = {
      connectionType: 'tws',
      port: 4002,
      clientId: 7,
      agentTradingEnabled: false,
      allowedAccountIds: [],
    }
    const input = { active: 'paper', profiles: { paper: profile, live: profile } }
    expect(ConnectionSettingsSchema.parse(input).profiles.paper).toMatchObject({
      connectionType: 'tws',
      port: 4002,
    })
    expect(input.profiles.paper.connectionType).toBe('tws')
    expect(connectionTypeLabel('tws')).toBe('TWS')
    expect(connectionTypeLabel('ib-gateway')).toBe('IB Gateway')
  })

  it('rejects unknown connection types instead of silently choosing one', () => {
    const profile = {
      connectionType: 'other',
      port: 4002,
      clientId: 7,
      agentTradingEnabled: false,
      allowedAccountIds: [],
    }
    expect(
      ConnectionSettingsSchema.safeParse({
        active: 'paper',
        profiles: { paper: profile, live: profile },
      }).success,
    ).toBe(false)
  })
})
