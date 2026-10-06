import { describe, expect, it, vi } from 'vitest'
import {
  createOptionChainGreeksStore,
  OPTION_CHAIN_GREEKS_STORAGE_KEY,
  optionChainColumns,
} from './option-chain-greeks.js'
import { WORKSTATION_WIDGETS } from './workstation-widgets.js'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  }
}

describe('option chain Greeks columns', () => {
  const columns = WORKSTATION_WIDGETS.optionChainOptions?.columns ?? []

  it('keeps the configured columns when Greeks are shown', () => {
    expect(optionChainColumns(columns, true)).toEqual(columns)
  })

  it('drops only delta, gamma, theta and vega when Greeks are hidden', () => {
    expect(optionChainColumns(columns, false)).toEqual([
      'last',
      'volume',
      'impliedVolatility',
      'bid',
      'ask',
    ])
  })
})

describe('option chain Greeks preference', () => {
  it('shows Greeks by default', () => {
    expect(createOptionChainGreeksStore(memoryStorage()).getSnapshot()).toBe(true)
    expect(createOptionChainGreeksStore().getSnapshot()).toBe(true)
  })

  it('restores and persists the viewer choice', () => {
    const storage = memoryStorage({ [OPTION_CHAIN_GREEKS_STORAGE_KEY]: 'hidden' })
    const store = createOptionChainGreeksStore(storage)
    expect(store.getSnapshot()).toBe(false)
    const receive = vi.fn()
    store.subscribe(receive)
    store.set(true)
    expect(store.getSnapshot()).toBe(true)
    expect(storage.setItem).toHaveBeenCalledWith(OPTION_CHAIN_GREEKS_STORAGE_KEY, 'shown')
    expect(receive).toHaveBeenCalledOnce()
    store.set(true)
    expect(receive).toHaveBeenCalledOnce()
  })

  it('keeps working when preference storage throws', () => {
    const store = createOptionChainGreeksStore({
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(store.getSnapshot()).toBe(true)
    store.set(false)
    expect(store.getSnapshot()).toBe(false)
  })
})
