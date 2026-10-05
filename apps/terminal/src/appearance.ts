export type Appearance = 'light' | 'dark'
type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>

export const APPEARANCE_STORAGE_KEY = 'ibkr-terminal:appearance:v1'

/** A local visual preference; it has no broker, licence or credential authority. */
export function createAppearanceStore(storage?: AppearanceStorage) {
  let appearance: Appearance = 'dark'
  try {
    const saved = storage?.getItem(APPEARANCE_STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') appearance = saved
  } catch {
    // Appearance still works when browser preference storage is unavailable.
  }
  const subscribers = new Set<() => void>()
  return {
    getSnapshot: () => appearance,
    subscribe(receive: () => void) {
      subscribers.add(receive)
      return () => {
        subscribers.delete(receive)
      }
    },
    set(next: Appearance) {
      if (next === appearance) return
      appearance = next
      try {
        storage?.setItem(APPEARANCE_STORAGE_KEY, next)
      } catch {
        // The active choice remains usable for this session.
      }
      for (const receive of subscribers) receive()
    },
  }
}

export type AppearanceStore = ReturnType<typeof createAppearanceStore>
