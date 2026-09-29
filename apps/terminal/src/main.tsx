import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ApplicationSetup } from './application-setup.js'
import { DesktopChrome } from './desktop-chrome.js'
import '@tradescript/pro/style.css'
import '@tradescript/pro/tailwind.css'
import '@tradescript/pro/react/style.css'
import './styles.css'

const root = document.querySelector<HTMLElement>('#root')
if (root === null) throw new Error('Missing application mount')

createRoot(root).render(
  <StrictMode>
    <DesktopChrome>
      <ApplicationSetup>
        <App />
      </ApplicationSetup>
    </DesktopChrome>
  </StrictMode>,
)
