import type { SdkSymbolInfo } from '@tradescript/pro/sdk'
import { useEffect, useRef, useState } from 'react'
import { AgentTradingButton } from './agent-trading.js'
import { AppNotification } from './app-notifications.js'
import { AppearanceToggle } from './appearance-ui.js'
import { ApplicationSettingsButton } from './application-setup.js'
import { retryConnection } from './connection-client.js'
import { ConnectionHealth, ConnectionRetry, useConnectionHealth } from './connection-health.js'
import { ConnectionSettingsButton } from './connection-settings.js'
import { TerminalToolbar } from './desktop-chrome.js'
import { DesktopUpdates } from './desktop-updates.js'
import {
  type ChartDataRow,
  type ChartDataSnapshot,
  type LoadState,
  useWorkstation,
} from './use-workstation.js'
import { type WorkstationSetupState, workstationLoading } from './workstation-startup.js'

const MOCK_MODE = import.meta.env.VITE_TRADING_MODE === 'mock'
export function App({ setup }: { setup: WorkstationSetupState }) {
  const [activeInstrument, setActiveInstrument] = useState<SdkSymbolInfo>()
  const terminalHost = useRef<HTMLDivElement>(null)
  const topbar = useRef<HTMLElement>(null)
  const sessionMetaHost = useRef<HTMLDivElement>(null)
  const chartBarsReader = useRef<() => ChartDataSnapshot>(() => ({ bars: [], interval: '5m' }))
  const [chartDataRows, setChartDataRows] = useState<ChartDataRow[]>([])
  const [chartDataOpen, setChartDataOpen] = useState(false)
  const [chartDataSnapshot, setChartDataSnapshot] = useState<ChartDataSnapshot>({
    bars: [],
    interval: '5m',
  })
  const [chartDataError, setChartDataError] = useState('')
  const [chartDataAttempt, setChartDataAttempt] = useState(0)
  const [retryPending, setRetryPending] = useState(false)
  const [retryError, setRetryError] = useState('')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const workstation = useWorkstation(
    terminalHost,
    sessionMetaHost,
    chartBarsReader,
    setActiveInstrument,
    setup.ready,
  )
  const loadState: LoadState = setup.ready
    ? workstation
    : setup.error
      ? { state: 'error', message: setup.error }
      : workstationLoading(setup.stage)
  const connection = useConnectionHealth(!MOCK_MODE && setup.ready)
  const previousBrokerState = useRef(connection.session?.state)

  const retryWorkstation = async () => {
    if (retryPending) return
    setRetryAttempt((attempt) => attempt + 1)
    setRetryPending(true)
    setRetryError('')
    try {
      if (!setup.ready) {
        await setup.retry()
        return
      }
      if (!MOCK_MODE) await retryConnection()
      workstation.retry()
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : 'The connection could not be retried.')
    } finally {
      setRetryPending(false)
    }
  }

  useEffect(() => {
    if (loadState.state !== 'error') setRetryError('')
  }, [loadState.state])

  useEffect(() => {
    const previous = previousBrokerState.current
    const current = connection.session?.state
    if (current === undefined) return
    previousBrokerState.current = current
    if (previous && previous !== 'ready' && current === 'ready' && loadState.state === 'error')
      workstation.retry()
  }, [connection.session?.state, loadState.state, workstation.retry])

  useEffect(() => {
    const header = topbar.current
    if (!header) return
    const size = () =>
      document.documentElement.style.setProperty(
        '--terminal-topbar-height',
        `${Math.ceil(header.getBoundingClientRect().height)}px`,
      )
    const observer = new ResizeObserver(size)
    observer.observe(header)
    size()
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--terminal-topbar-height')
    }
  }, [])

  useEffect(() => {
    if (!chartDataOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChartDataOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [chartDataOpen])

  const openChartData = async () => {
    setChartDataAttempt((attempt) => attempt + 1)
    const snapshot = chartBarsReader.current()
    const symbol = snapshot.symbol ?? activeInstrument
    let rows = snapshot.bars
    setChartDataError('')
    setChartDataRows([])
    setChartDataSnapshot({ ...snapshot, ...(symbol ? { symbol } : {}) })
    setChartDataOpen(true)
    try {
      if (rows.length === 0) {
        const endTime = Date.now()
        const startTime = endTime - 7 * 24 * 60 * 60 * 1_000
        const params = new URLSearchParams({
          symbol: symbol?.brokerSymbol ?? symbol?.ticker ?? '',
          exchange: symbol?.exchange ?? '',
          primaryExchange: symbol?.listedExchange ?? '',
          currency: symbol?.currency ?? '',
          assetClass: symbol?.type ?? '',
          interval: snapshot.interval,
          startTime: String(startTime),
          endTime: String(endTime),
          barCount: '250',
        })
        const response = await fetch(`/api/v1/ibkr/bars?${params}`, {
          credentials: 'same-origin',
          headers: { 'x-tradescript-client': 'terminal-v1' },
        })
        if (!response.ok)
          throw new Error('Chart data is unavailable. Try again when the connection is ready.')
        {
          const history = (await response.json()) as { bars?: ChartDataRow[] }
          rows = history.bars ?? []
        }
      }
      setChartDataRows(rows.slice(-250).reverse())
    } catch (error) {
      setChartDataRows([])
      setChartDataError(error instanceof Error ? error.message : 'Chart data could not be loaded.')
    }
  }

  return (
    <main className="app-shell">
      <AppNotification message={retryError} occurrence={retryAttempt} />
      <AppNotification message={chartDataError} occurrence={chartDataAttempt} />
      <TerminalToolbar headerRef={topbar}>
        <div ref={sessionMetaHost} className="toolbar-market-session" />
        {!MOCK_MODE && setup.ready && (
          <div className="toolbar-connection">
            <ConnectionHealth connection={connection} />
            <ConnectionSettingsButton />
          </div>
        )}
        {!MOCK_MODE && setup.ready && (
          <AgentTradingButton
            onChanged={workstation.retry}
            agentRisk={loadState.state === 'ready' ? loadState.agentRisk : undefined}
          />
        )}
        {MOCK_MODE && loadState.state !== 'ready' && (
          <span className={`header-status ${loadState.state}`} role="status">
            {loadState.state === 'error' ? 'Unavailable' : 'Connecting…'}
          </span>
        )}
        {MOCK_MODE && <span className="header-simulation">Simulated session</span>}
        <div className="toolbar-utilities">
          <AppearanceToggle />
          {!MOCK_MODE && setup.ready && <ApplicationSettingsButton />}
          <button
            type="button"
            className="chart-data-action"
            aria-label="Chart data"
            title="View chart data"
            disabled={loadState.state !== 'ready'}
            onClick={() => void openChartData()}
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
              <rect x="3" y="3" width="14" height="14" rx="2" />
              <path d="M3 8h14M8 8v9M3 12.5h14" />
            </svg>
          </button>
          <DesktopUpdates />
        </div>
      </TerminalToolbar>

      <section className="terminal-frame" aria-busy={loadState.state === 'loading'}>
        <div ref={terminalHost} className="terminal-host" />
        {loadState.state !== 'ready' && (
          <div className={`terminal-overlay ${loadState.state}`} role="status">
            <strong>
              {loadState.state === 'error' ? 'Workstation unavailable' : 'Starting workstation'}
            </strong>
            <p>{loadState.message}</p>
            {loadState.state === 'loading' && (
              <div className="terminal-startup-progress">
                <progress
                  value={loadState.progress.completed}
                  max={loadState.progress.total}
                  aria-label="Workstation startup"
                  aria-valuetext={`${loadState.progress.completed} of ${loadState.progress.total} stages complete. ${loadState.message}`}
                />
                <span>
                  Step {loadState.progress.completed + 1} of {loadState.progress.total}
                </span>
              </div>
            )}
            {loadState.state === 'error' && (
              <button type="button" disabled={retryPending} onClick={() => void retryWorkstation()}>
                {setup.ready ? 'Retry workstation' : 'Retry setup'}
              </button>
            )}
            {!MOCK_MODE && loadState.state === 'error' && (
              <ConnectionRetry session={connection.session} now={connection.now} />
            )}
          </div>
        )}
      </section>
      {chartDataOpen && (
        <div className="chart-data-backdrop" role="presentation">
          <section
            className="chart-data-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chart-data-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setChartDataOpen(false)
            }}
          >
            <header>
              <div>
                <strong id="chart-data-title">
                  {chartDataSnapshot.symbol?.ticker ?? 'Unknown instrument'} chart data
                </strong>
                <span>{chartDataSnapshot.interval} bars · newest first</span>
              </div>
              <button type="button" onClick={() => setChartDataOpen(false)}>
                Close
              </button>
            </header>
            <div className="chart-data-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Open</th>
                    <th scope="col">High</th>
                    <th scope="col">Low</th>
                    <th scope="col">Close</th>
                    <th scope="col">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {chartDataRows.map((bar) => (
                    <tr key={bar.time}>
                      <td>{new Date(bar.time).toLocaleString()}</td>
                      <td>{chartDataSnapshot.formatPrice?.(bar.open) ?? String(bar.open)}</td>
                      <td>{chartDataSnapshot.formatPrice?.(bar.high) ?? String(bar.high)}</td>
                      <td>{chartDataSnapshot.formatPrice?.(bar.low) ?? String(bar.low)}</td>
                      <td>{chartDataSnapshot.formatPrice?.(bar.close) ?? String(bar.close)}</td>
                      <td>{bar.volume?.toLocaleString() ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!chartDataError && chartDataRows.length === 0 && <p>No chart bars are available.</p>}
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
