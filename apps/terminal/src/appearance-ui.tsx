import { ChartUiThemeProvider, StandardModal } from '@tradescript/pro/react/ui'
import { chartButtonThemeStyle } from '@tradescript/pro/sdk/theme'
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useSyncExternalStore,
} from 'react'
import type { AppearanceStore } from './appearance.js'
import { WORKSTATION_THEMES } from './workstation-theme.js'

const AppearanceContext = createContext<AppearanceStore | undefined>(undefined)

export function AppearanceProvider({
  store,
  children,
}: {
  readonly store: AppearanceStore
  readonly children: ReactNode
}) {
  const appearance = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const themeStyle = Object.fromEntries(
    Object.entries(chartButtonThemeStyle(WORKSTATION_THEMES[appearance])).filter(
      ([, value]) => typeof value === 'string' || typeof value === 'number',
    ),
  )
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appearance
  }, [appearance])
  return (
    <AppearanceContext.Provider value={store}>
      <ChartUiThemeProvider theme={appearance} themeStyle={themeStyle}>
        {children}
      </ChartUiThemeProvider>
    </AppearanceContext.Provider>
  )
}

export function useAppearanceStore(): AppearanceStore {
  const store = useContext(AppearanceContext)
  if (!store) throw new Error('The app appearance provider is missing.')
  return store
}

export function AppearanceToggle() {
  const store = useAppearanceStore()
  const appearance = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return (
    <button
      type="button"
      className="appearance-toggle"
      aria-label="Light mode"
      title={appearance === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      aria-pressed={appearance === 'light'}
      onClick={() => store.set(appearance === 'light' ? 'dark' : 'light')}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <circle cx="10" cy="10" r="3.2" />
        <path d="M10 1v2m0 14v2M1 10h2m14 0h2M3.6 3.6 5 5m10 10 1.4 1.4M3.6 16.4 5 15m10-10 1.4-1.4" />
      </svg>
    </button>
  )
}

/** Host dialogs use the SDK's public geometry and theme contracts. */
export function AppModal({ style, ...props }: ComponentProps<typeof StandardModal>) {
  return (
    <StandardModal
      draggable={false}
      resizable={false}
      {...props}
      style={{
        borderRadius: '20px',
        backdropFilter: 'var(--app-glass-filter, blur(28px) saturate(145%))',
        WebkitBackdropFilter: 'var(--app-glass-filter, blur(28px) saturate(145%))',
        backgroundImage:
          'linear-gradient(135deg, var(--app-glass-shine, rgba(255,255,255,0.05)), transparent 48%)',
        ...style,
      }}
    />
  )
}
