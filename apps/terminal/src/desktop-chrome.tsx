import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ReactNode, Ref } from 'react'
import { AppearanceToggle } from './appearance-ui.js'
import { APP_LOGO, APP_NAME } from './branding.js'
import { AboutDialog } from './legal-notices.js'

const desktop = isTauri()
const mac = /Mac/.test(navigator.platform)
if (desktop) document.documentElement.dataset.desktop = mac ? 'mac' : 'windows'

function WindowControls() {
  if (!desktop || mac) return null
  const window = getCurrentWindow()
  const control = (action: () => Promise<void>) => {
    void action().catch(() => console.warn('The window action could not be completed.'))
  }
  return (
    <div className="desktop-window-controls" data-tauri-drag-region="false">
      <button
        type="button"
        aria-label="Minimize window"
        onClick={() => control(() => window.minimize())}
      >
        −
      </button>
      <button
        type="button"
        aria-label="Maximize or restore window"
        onClick={() => control(() => window.toggleMaximize())}
      >
        □
      </button>
      <button type="button" aria-label="Close window" onClick={() => control(() => window.close())}>
        ×
      </button>
    </div>
  )
}

export function TerminalToolbar({
  children,
  headerRef,
}: {
  readonly children?: ReactNode
  readonly headerRef?: Ref<HTMLElement>
}) {
  return (
    <header
      className="topbar"
      ref={headerRef}
      data-tauri-drag-region={desktop ? 'deep' : undefined}
    >
      <div className="brand-lockup">
        <img className="brand-mark" src={APP_LOGO} alt="" />
        <strong>{APP_NAME}</strong>
      </div>
      {children && (
        <div className="header-actions" data-tauri-drag-region="false">
          {children}
        </div>
      )}
      <WindowControls />
    </header>
  )
}

export function DesktopSetupToolbar() {
  return (
    <TerminalToolbar>
      <AppearanceToggle />
    </TerminalToolbar>
  )
}

export function DesktopChrome({ children }: { readonly children: ReactNode }) {
  if (!desktop) return children
  return (
    <>
      <div className="desktop-content">{children}</div>
      <AboutDialog />
    </>
  )
}
