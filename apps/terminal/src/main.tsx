import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { AppNotificationsProvider } from './app-notifications.js'
import { createAppearanceStore } from './appearance.js'
import { AppearanceProvider } from './appearance-ui.js'
import { ApplicationSetup } from './application-setup.js'
import { DesktopChrome } from './desktop-chrome.js'
import '@tradescript/pro/style.css'
import '@tradescript/pro/tailwind.css'
import '@tradescript/pro/react/style.css'
import './styles.css'

const root = document.querySelector<HTMLElement>('#root')
if (root === null) throw new Error('Missing application mount')
let preferenceStorage: Storage | undefined
try {
  preferenceStorage = window.localStorage
} catch {
  // A blocked preference store must not prevent the app from opening.
}
const appearance = createAppearanceStore(preferenceStorage)
document.documentElement.dataset.theme = appearance.getSnapshot()

createRoot(root).render(
  <StrictMode>
    <AppearanceProvider store={appearance}>
      <AppNotificationsProvider>
        <DesktopChrome>
          <ApplicationSetup>{(setup) => <App setup={setup} />}</ApplicationSetup>
        </DesktopChrome>
      </AppNotificationsProvider>
    </AppearanceProvider>
  </StrictMode>,
)
