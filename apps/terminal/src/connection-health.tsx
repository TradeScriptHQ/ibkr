import type { HealthResponse } from '@ibkr-terminal/contracts'
import { useEffect, useState } from 'react'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'

export function connectionHealthLabel(health: HealthResponse) {
  if (health.connectionStatus === 'connecting')
    return { tone: 'pending', label: 'Connecting…', detail: 'Connecting to TWS.' }
  if (health.connectionStatus !== 'connected')
    return {
      tone: 'error',
      label: 'TWS offline',
      detail: 'The TWS connection is unavailable. Displayed prices may be last-known values.',
    }
  const data = health.marketDataConnection
  if (data?.status === 'disconnected')
    return { tone: 'error', label: 'Market data offline', detail: data.message }
  if (data?.status === 'degraded')
    return { tone: 'warning', label: 'Market data disrupted', detail: data.message }
  return {
    tone: 'connected',
    label: 'TWS connected',
    detail: 'Connected to TWS. Quote subscriptions may provide delayed data.',
  }
}

export function ConnectionHealth() {
  const [status, setStatus] = useState({
    tone: 'pending',
    label: 'Connecting…',
    detail: 'Checking the TWS connection.' as string | undefined,
  })
  useEffect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout>
    let controller: AbortController | undefined
    const refresh = async () => {
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 5000)
      try {
        await bootstrapBrowserSession()
        if (closed) return
        const response = await fetch('/api/v1/ibkr/health', {
          headers: CLIENT_HEADERS,
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Gateway unavailable')
        const health: HealthResponse = await response.json()
        if (!closed) setStatus(connectionHealthLabel(health))
      } catch {
        if (!closed)
          setStatus({
            tone: 'error',
            label: 'Gateway offline',
            detail: 'Cannot reach the trading gateway. Displayed prices may be last-known values.',
          })
      } finally {
        clearTimeout(timeout)
        if (!closed) timer = setTimeout(refresh, 2000)
      }
    }
    void refresh()
    return () => {
      closed = true
      clearTimeout(timer)
      controller?.abort()
    }
  }, [])
  return (
    <span
      className="connection-health"
      data-tone={status.tone}
      role="status"
      title={status.detail}
      data-testid="connection-health"
    >
      <span aria-hidden="true" />
      {status.label}
    </span>
  )
}
