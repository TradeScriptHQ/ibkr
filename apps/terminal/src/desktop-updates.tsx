import { invoke, isTauri } from '@tauri-apps/api/core'
import { useCallback, useEffect, useState } from 'react'

interface UpdateStatus {
  configured: boolean
  version: string | null
  notes: string | null
}
export function DesktopUpdates() {
  const [update, setUpdate] = useState<UpdateStatus>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const check = useCallback(async () => {
    setBusy(true)
    try {
      const next = await invoke<UpdateStatus>('check_update')
      setUpdate(next)
      setMessage(
        next.configured
          ? next.version
            ? `Version ${next.version} is available.`
            : 'You are up to date.'
          : 'Updates are not configured in this test build.',
      )
    } catch {
      setMessage('Could not check for updates. Try again later.')
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => {
    if (!isTauri()) return
    void check()
    const timer = window.setInterval(() => void check(), 6 * 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [check])
  if (!isTauri()) return null
  const install = async () => {
    if (!update?.version) return
    setBusy(true)
    setMessage('Downloading update…')
    try {
      await invoke('install_update', { version: update.version })
    } catch {
      setMessage(
        'Update could not be installed. Restart the app if the connection stopped, then try again.',
      )
      setBusy(false)
    }
  }
  return (
    <details className="desktop-updates">
      <summary>{update?.version ? 'Update available' : 'Updates'}</summary>
      <div className="desktop-update-panel">
        <p role="status">{message}</p>
        {update?.notes && <p>{update.notes}</p>}
        {update?.version && (
          <p>
            Installing restarts the workstation and disconnects its local bridge. Orders already at
            IBKR are not cancelled.
          </p>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void (update?.version ? install() : check())}
        >
          {busy ? 'Please wait…' : update?.version ? 'Install and restart' : 'Check for updates'}
        </button>
      </div>
    </details>
  )
}
