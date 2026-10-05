import { invoke, isTauri } from '@tauri-apps/api/core'
import { useCallback, useEffect, useState } from 'react'
import { AppNotification } from './app-notifications.js'

interface UpdateStatus {
  configured: boolean
  version: string | null
  notes: string | null
}
export function DesktopUpdates() {
  const enabled = isTauri() && !import.meta.env.DEV
  const [update, setUpdate] = useState<UpdateStatus>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [notificationAttempt, setNotificationAttempt] = useState(0)
  const [tone, setTone] = useState<'error' | 'success' | 'info'>('info')
  const check = useCallback(async (manual = false) => {
    setBusy(true)
    if (manual) {
      setNotificationAttempt((attempt) => attempt + 1)
      setMessage('')
    }
    try {
      const next = await invoke<UpdateStatus>('check_update')
      setUpdate(next)
      setTone(next.configured && !next.version ? 'success' : 'info')
      if (manual || next.version)
        setMessage(
          next.configured
            ? next.version
              ? `Version ${next.version} is available.`
              : 'You are up to date.'
            : 'Updates are not configured in this test build.',
        )
      else setMessage('')
    } catch {
      setTone('error')
      setMessage('Could not check for updates. Try again later.')
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => {
    if (!enabled) return
    void check()
    const timer = window.setInterval(() => void check(), 6 * 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [check, enabled])
  if (!enabled) return null
  const install = async () => {
    if (!update?.version) return
    setNotificationAttempt((attempt) => attempt + 1)
    setBusy(true)
    setTone('info')
    setMessage('Downloading update…')
    try {
      await invoke('install_update', { version: update.version })
    } catch {
      setTone('error')
      setMessage(
        'Update could not be installed. Restart the app if the connection stopped, then try again.',
      )
      setBusy(false)
    }
  }
  return (
    <>
      <AppNotification message={message} tone={tone} occurrence={notificationAttempt} />
      <details className="desktop-updates">
        <summary
          aria-label={update?.version ? 'Update available' : 'Updates'}
          title={update?.version ? 'Update available' : 'Updates'}
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
            <path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4" />
          </svg>
          {update?.version && <span className="desktop-update-indicator" aria-hidden="true" />}
        </summary>
        <div className="desktop-update-panel">
          <p>{update?.version ? `Version ${update.version} is available.` : 'App updates'}</p>
          {update?.notes && <p>{update.notes}</p>}
          {update?.version && (
            <p>
              Installing restarts the workstation and disconnects its local bridge. Orders already
              at IBKR are not cancelled.
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void (update?.version ? install() : check(true))}
          >
            {busy ? 'Please wait…' : update?.version ? 'Install and restart' : 'Check for updates'}
          </button>
        </div>
      </details>
    </>
  )
}
