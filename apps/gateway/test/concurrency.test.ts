import { expect, it } from 'vitest'
import { mapWithConcurrency } from '../src/ibkr/concurrency.js'

it('bounds in-flight work while preserving input order across out-of-order completion', async () => {
  const release: Array<() => void> = []
  const started: number[] = []
  const result = mapWithConcurrency([10, 20, 30], 2, async (value) => {
    started.push(value)
    await new Promise<void>((resolve) => release.push(resolve))
    return value * 2
  })
  expect(started).toEqual([10, 20])
  release[1]?.()
  await Promise.resolve()
  await Promise.resolve()
  expect(started).toEqual([10, 20, 30])
  release[2]?.()
  release[0]?.()
  expect(await result).toEqual([20, 40, 60])
})

it('propagates a failed request instead of returning a partial result', async () => {
  await expect(
    mapWithConcurrency([1], 1, async () => {
      throw new Error('Broker request failed')
    }),
  ).rejects.toThrow('Broker request failed')
})
