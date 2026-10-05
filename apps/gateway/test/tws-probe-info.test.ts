import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  api: undefined as EventEmitter | undefined,
}))
vi.mock('@stoqey/ib', async (original) => {
  const actual = await original<typeof import('@stoqey/ib')>()
  return {
    ...actual,
    // biome-ignore lint/complexity/useArrowFunction: This mock is called as a constructor.
    IBApi: vi.fn(function () {
      return mocked.api
    }),
  }
})

import { EventName } from '@stoqey/ib'
import { discoverTwsAccounts } from '../src/connections/test-connection.js'

afterEach(() => {
  mocked.api = undefined
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('reports a real-library info client conflict without waiting for the generic probe timeout', async () => {
  vi.useFakeTimers()
  const api = Object.assign(new EventEmitter(), {
    connect: vi.fn(),
    disconnect: vi.fn(),
  })
  mocked.api = api
  const discovered = discoverTwsAccounts('127.0.0.1', 7497, 7)
  const rejected = expect(discovered).rejects.toMatchObject({
    statusCode: 409,
  })
  api.emit(EventName.info, 'Client ID already in use', 326)
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  expect(api.disconnect).toHaveBeenCalledOnce()
})

it('still returns broker-discovered account identities and cleans up the probe', async () => {
  const api = Object.assign(new EventEmitter(), {
    connect: vi.fn(),
    disconnect: vi.fn(),
  })
  mocked.api = api
  const discovered = discoverTwsAccounts('127.0.0.1', 7497, 7)
  api.emit(EventName.managedAccounts, 'DU-SYNTHETIC,DU-SECOND,DU-SYNTHETIC')
  await expect(discovered).resolves.toEqual(['DU-SYNTHETIC', 'DU-SECOND'])
  expect(api.disconnect).toHaveBeenCalledOnce()
})

it('identifies IB Gateway in a failed handshake for an advanced port', async () => {
  const api = Object.assign(new EventEmitter(), {
    connect: vi.fn(),
    disconnect: vi.fn(),
  })
  mocked.api = api
  const discovered = discoverTwsAccounts('127.0.0.1', 4051, 7, 'ib-gateway')
  const rejected = expect(discovered).rejects.toThrow('Could not connect to IB Gateway')
  api.emit(EventName.info, 'Connection failed', 502)
  await rejected
  expect(api.disconnect).toHaveBeenCalledOnce()
})
