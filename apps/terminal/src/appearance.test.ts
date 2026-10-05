import { describe, expect, it, vi } from 'vitest'
import { APPEARANCE_STORAGE_KEY, createAppearanceStore } from './appearance.js'

describe('local appearance preference', () => {
  it('restores a saved choice on a fresh app instance', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    const first = createAppearanceStore(storage)
    first.set('light')
    expect(createAppearanceStore(storage).getSnapshot()).toBe('light')
    first.set('dark')
    expect(createAppearanceStore(storage).getSnapshot()).toBe('dark')
    expect([...values.keys()]).toEqual([APPEARANCE_STORAGE_KEY])
  })

  it('retains the dark default for missing or unsupported stored choices', () => {
    for (const saved of [null, '', 'system', 'unexpected']) {
      const storage = { getItem: () => saved, setItem: vi.fn() }
      expect(createAppearanceStore(storage).getSnapshot()).toBe('dark')
      expect(storage.setItem).not.toHaveBeenCalled()
    }
  })

  it('switches the active appearance even when preference storage is blocked', () => {
    const store = createAppearanceStore({
      getItem: () => {
        throw new Error('Storage unavailable')
      },
      setItem: () => {
        throw new Error('Storage unavailable')
      },
    })
    const receive = vi.fn(() => store.getSnapshot())
    store.subscribe(receive)
    store.set('light')
    expect(store.getSnapshot()).toBe('light')
    expect(receive).toHaveReturnedWith('light')
  })

  it('publishes only appearance changes and stops notifying a disposed consumer', () => {
    const store = createAppearanceStore()
    const receive = vi.fn(() => store.getSnapshot())
    const stop = store.subscribe(receive)
    store.set('dark')
    expect(receive).not.toHaveBeenCalled()
    store.set('light')
    expect(receive).toHaveReturnedWith('light')
    stop()
    store.set('dark')
    expect(receive).toHaveBeenCalledTimes(1)
  })
})
