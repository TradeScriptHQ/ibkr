import { describe, expect, it } from 'vitest'
import { withoutUndefined } from './defined-fields.js'

describe('gateway optional fields', () => {
  it('omits missing nested fields while preserving explicit clearing values and zero', () => {
    const mapped = withoutUndefined<{
      legs: { price?: number; size: number }[]
      displaySize: number | null
    }>({ legs: [{ price: undefined, size: 0 }], displaySize: null })
    expect(mapped).toStrictEqual({ legs: [{ size: 0 }], displaySize: null })
  })

  it('preserves callback and non-plain values without modifying the input', () => {
    const callback = () => 42
    const date = new Date(0)
    const input = { callback, date, missing: undefined }
    const mapped = withoutUndefined<{ callback: () => number; date: Date; missing?: string }>(input)
    expect(mapped.callback).toBe(callback)
    expect(mapped.date).toBe(date)
    expect(mapped).not.toHaveProperty('missing')
    expect(input).toHaveProperty('missing')
  })
})
