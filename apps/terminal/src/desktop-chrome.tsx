import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ReactNode } from 'react'

const desktop = isTauri()
const mac = /Mac/.test(navigator.platform)
if (desktop) document.documentElement.dataset.desktop = mac ? 'mac' : 'windows'

export function DesktopChrome({ children }: { readonly children: ReactNode }) {
  if (!desktop) return children
  const window = getCurrentWindow()
  const control = (action: () => Promise<void>) => {
    void action().catch(() => console.warn('The window action could not be completed.'))
  }
  return (
    <>
      <header className="desktop-titlebar" data-tauri-drag-region>
        <span className="desktop-title" data-tauri-drag-region>
          <img src="/tradescript-mark.svg" alt="" />
          TradeScript <span data-tauri-drag-region>Terminal</span>
        </span>
        {!mac && (
          <div className="desktop-window-controls">
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
            <button
              type="button"
              aria-label="Close window"
              onClick={() => control(() => window.close())}
            >
              ×
            </button>
          </div>
        )}
      </header>
      <div className="desktop-content">{children}</div>
    </>
  )
}
