import type {
  OptionChainReferencePriceExtensionContext,
  OptionChainSurfaceColumnSpec,
  TradeScriptDomExtension,
} from '@tradescript/pro/sdk'

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

export const OPTION_CHAIN_GREEKS_STORAGE_KEY = 'ibkr-terminal:option-chain-greeks:v1'

const GREEK_COLUMNS: ReadonlySet<OptionChainSurfaceColumnSpec> = new Set([
  'delta',
  'gamma',
  'theta',
  'vega',
])

/** Drop the Greek columns while keeping the host's order for everything else. */
export function optionChainColumns(
  columns: readonly OptionChainSurfaceColumnSpec[],
  showGreeks: boolean,
): readonly OptionChainSurfaceColumnSpec[] {
  return showGreeks ? columns : columns.filter((column) => !GREEK_COLUMNS.has(column))
}

/** A local display preference; it changes columns only, never quote subscriptions. */
export function createOptionChainGreeksStore(storage?: PreferenceStorage) {
  let visible = true
  try {
    visible = storage?.getItem(OPTION_CHAIN_GREEKS_STORAGE_KEY) !== 'hidden'
  } catch {
    // The chain still shows Greeks when browser preference storage is unavailable.
  }
  const subscribers = new Set<() => void>()
  return {
    getSnapshot: () => visible,
    subscribe(receive: () => void) {
      subscribers.add(receive)
      return () => {
        subscribers.delete(receive)
      }
    },
    set(next: boolean) {
      if (next === visible) return
      visible = next
      try {
        storage?.setItem(OPTION_CHAIN_GREEKS_STORAGE_KEY, next ? 'shown' : 'hidden')
      } catch {
        // The active choice remains usable for this session.
      }
      for (const receive of subscribers) receive()
    },
  }
}

export type OptionChainGreeksStore = ReturnType<typeof createOptionChainGreeksStore>

/** Place a Greeks toggle beside the SDK's own underlying reference in the chain header. */
export function createOptionChainGreeksToggle(
  store: OptionChainGreeksStore,
): TradeScriptDomExtension<OptionChainReferencePriceExtensionContext> {
  return {
    mount(container, initial) {
      const row = document.createElement('div')
      row.className = 'ibkr-option-chain-reference'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ibkr-option-chain-greeks'
      button.textContent = 'Greeks'
      const reference = document.createElement('div')
      reference.className = 'ibkr-option-chain-reference-status'
      row.append(button, reference)
      container.append(row)
      const content = initial.defaultContent.mount(reference)
      const render = () => {
        const visible = store.getSnapshot()
        button.setAttribute('aria-pressed', String(visible))
        button.title = visible
          ? 'Hide delta, gamma, theta and vega'
          : 'Show delta, gamma, theta and vega'
      }
      const toggle = () => store.set(!store.getSnapshot())
      button.addEventListener('click', toggle)
      const unsubscribe = store.subscribe(render)
      render()
      return {
        update() {},
        destroy() {
          unsubscribe()
          button.removeEventListener('click', toggle)
          content.destroy()
          row.remove()
        },
      }
    },
  }
}
