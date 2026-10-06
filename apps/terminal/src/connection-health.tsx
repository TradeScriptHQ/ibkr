import {
  connectionTypeLabel,
  type HealthResponse,
  inferConnectionType,
  type RequirementStatus,
  SystemStatusResponseSchema,
} from '@ibkr-terminal/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'

export function connectionRecoveryDetails(session: RequirementStatus | undefined, now: number) {
  const connection = session?.connection
  if (!session || !connection || session.state === 'ready') return undefined
  if (!connection.issue && !connection.retry) return undefined
  const broker = connectionTypeLabel(connection.connectionType)
  const message =
    connection.issue === 'client-id-in-use'
      ? `${broker} rejected client ID ${connection.clientId} because it is already in use.`
      : connection.issue === 'ibkr-connectivity-lost'
        ? `${broker} lost its connection to IBKR.`
        : session.message
  let retry: string | undefined
  const progress = connection.retry
    ? `(${connection.retry.attempt} of ${connection.retry.maxAttempts})`
    : ''
  if (connection.retry?.exhausted) {
    retry = `Automatic retries stopped ${progress}`
  } else if (connection.retry?.nextAttemptAt) {
    const seconds = Math.max(
      0,
      Math.ceil((Date.parse(connection.retry.nextAttemptAt) - now) / 1000),
    )
    retry = `Retrying in ${seconds} ${seconds === 1 ? 'second' : 'seconds'} ${progress}`
  } else if (session.state === 'reconciling') {
    retry = 'Connection accepted. Checking broker state before resuming the workstation…'
  } else if (connection.retry && session.state === 'connecting') {
    retry = `Retrying… ${progress}`
  } else if (connection.issue === 'ibkr-connectivity-lost') {
    retry = `Waiting for ${broker} to restore its IBKR connection.`
  } else if (connection.retry) {
    retry = `Waiting for ${broker} to close the rejected connection before retrying.`
  }
  return {
    message,
    retry,
  }
}

export function connectionHealthLabel(health: HealthResponse, session?: RequirementStatus) {
  const broker = connectionTypeLabel(
    session?.connection?.connectionType ??
      health.connectionType ??
      inferConnectionType(health.ibkrPort),
  )
  const recovery = connectionRecoveryDetails(session, Date.now())
  if (session?.connection?.issue === 'ibkr-connectivity-lost')
    return { tone: 'error', label: 'IBKR connection lost', detail: recovery?.message }
  if (session?.state === 'reconciling')
    return { tone: 'pending', label: 'Restoring broker state…', detail: session.message }
  if (session?.connection?.retry && session.state !== 'error')
    return {
      tone: 'warning',
      label: `${broker} retrying`,
      detail: recovery?.message,
    }
  if (session?.state === 'error')
    return { tone: 'error', label: `${broker} unavailable`, detail: session.message }
  if (session?.state === 'degraded')
    return { tone: 'warning', label: `${broker} disrupted`, detail: session.message }
  if (session?.state === 'connecting')
    return { tone: 'pending', label: 'Connecting…', detail: session.message }
  if (health.connectionStatus === 'connecting')
    return { tone: 'pending', label: 'Connecting…', detail: `Connecting to ${broker}.` }
  if (session?.state === 'disconnected' || health.connectionStatus !== 'connected')
    return {
      tone: 'error',
      label: `${broker} offline`,
      detail:
        session?.message ??
        `The ${broker} connection is unavailable. Displayed prices may be last-known values.`,
    }
  if (health.competingLiveSession)
    return {
      tone: 'warning',
      label: 'Market data blocked',
      detail: `IBKR reports a competing live session (10197) and is withholding prices and chart history. Restart ${broker} and log in again; if this persists, sign out of IBKR Mobile, Client Portal and any other IBKR login.`,
    }
  const data = health.marketDataConnection
  if (data?.status === 'disconnected')
    return { tone: 'error', label: 'Market data offline', detail: data.message }
  if (data?.status === 'degraded')
    return { tone: 'warning', label: 'Market data disrupted', detail: data.message }
  return {
    tone: 'connected',
    label: `${broker} connected`,
    detail: `Connected to ${broker}. Quote subscriptions may provide delayed data.`,
  }
}

export function useConnectionHealth(enabled = true) {
  const [status, setStatus] = useState({
    tone: 'pending',
    label: 'Connecting…',
    detail: 'Checking the broker connection.' as string | undefined,
  })
  const [session, setSession] = useState<RequirementStatus>()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    let closed = false
    let timer: ReturnType<typeof setTimeout>
    let controller: AbortController | undefined
    const refresh = async () => {
      controller = new AbortController()
      const currentController = controller
      const timeout = setTimeout(() => currentController.abort(), 5000)
      let reachedBackend = false
      try {
        await bootstrapBrowserSession()
        if (closed) return
        const [response, readinessResponse] = await Promise.all(
          ['/api/v1/ibkr/health', '/api/v1/status'].map((path) =>
            fetch(path, { headers: CLIENT_HEADERS, signal: currentController.signal }),
          ),
        )
        reachedBackend = true
        if (!response?.ok || !readinessResponse?.ok) throw new Error('Status unavailable')
        const health: HealthResponse = await response.json()
        const readiness = SystemStatusResponseSchema.parse(await readinessResponse.json())
        const brokerSession = readiness.requirements.find(({ id }) => id === 'tws-session')
        if (!closed) {
          setSession(brokerSession)
          setStatus(connectionHealthLabel(health, brokerSession))
          setNow(Date.now())
        }
      } catch {
        if (!closed) {
          setSession(undefined)
          setStatus({
            tone: 'error',
            label: reachedBackend ? 'Connection status unavailable' : 'Terminal backend offline',
            detail: reachedBackend
              ? 'Could not read connection status from the Terminal backend.'
              : 'Cannot reach the Terminal backend. Displayed prices may be last-known values.',
          })
        }
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
  }, [enabled])
  useEffect(() => {
    if (!session?.connection?.retry?.nextAttemptAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [session?.connection?.retry?.nextAttemptAt])
  return { status, session, now }
}

export function ConnectionRetry({
  session,
  now,
}: {
  session: RequirementStatus | undefined
  now: number
}) {
  const recovery = connectionRecoveryDetails(session, now)
  if (!recovery?.retry) return null
  return <p className="connection-retry-timing">{recovery.retry}</p>
}

export function ConnectionRecovery({
  session,
  now,
}: {
  session: RequirementStatus | undefined
  now: number
}) {
  const recovery = connectionRecoveryDetails(session, now)
  if (!recovery) return null
  return (
    <div className="connection-recovery" data-testid="connection-recovery">
      <p>{recovery.message}</p>
      <ConnectionRetry session={session} now={now} />
    </div>
  )
}

export function ConnectionHealth({
  connection,
}: {
  connection: ReturnType<typeof useConnectionHealth>
}) {
  const { status, session, now } = connection
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const details = useRef<HTMLElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target) &&
        !details.current?.contains(event.target)
      )
        setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])
  return (
    <div className="connection-health-control" ref={container}>
      <button
        type="button"
        className="connection-health"
        data-tone={status.tone}
        title={status.detail}
        aria-label={`Connection status: ${status.label}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
        data-testid="connection-health"
      >
        <span aria-hidden="true" />
        <span className="connection-health-label" role="status">
          {status.label}
        </span>
      </button>
      {open &&
        createPortal(
          <section
            id={id}
            ref={details}
            className="connection-health-details"
            role="dialog"
            aria-label="Broker connection status"
          >
            <header>
              <strong>{status.label}</strong>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close connection status"
              >
                ×
              </button>
            </header>
            {connectionRecoveryDetails(session, now) ? (
              <ConnectionRecovery session={session} now={now} />
            ) : (
              <p>{status.detail}</p>
            )}
          </section>,
          document.body,
        )}
    </div>
  )
}
