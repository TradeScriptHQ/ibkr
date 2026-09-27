import type { SdkSymbolInfo } from '@tradescript/pro/sdk'
import { useEffect, useRef, useState } from 'react'
import { ApplicationSettingsButton } from './application-setup.js'
import { ConnectionHealth } from './connection-health.js'
import { ConnectionSettingsButton } from './connection-settings.js'
import { DesktopUpdates } from './desktop-updates.js'
import { type ChartDataRow, useWorkstation } from './use-workstation.js'

const MOCK_MODE = import.meta.env.VITE_TRADING_MODE === 'mock'
export function App() {
  const [activeInstrument, setActiveInstrument] = useState<SdkSymbolInfo>()
  const terminalHost = useRef<HTMLDivElement>(null)
  const chartBarsReader = useRef<() => ChartDataRow[]>(() => [])
  const [chartDataRows, setChartDataRows] = useState<ChartDataRow[]>([])
  const [chartDataOpen, setChartDataOpen] = useState(false)
  const loadState = useWorkstation(terminalHost, chartBarsReader, setActiveInstrument)

  useEffect(() => {
    if (!chartDataOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChartDataOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [chartDataOpen])

  const openChartData = async () => {
    let rows = chartBarsReader.current()
    if (rows.length === 0) {
      const endTime = Date.now()
      const startTime = endTime - 7 * 24 * 60 * 60 * 1_000
      const params = new URLSearchParams({
        symbol: activeInstrument?.brokerSymbol ?? activeInstrument?.ticker ?? '',
        exchange: activeInstrument?.exchange ?? '',
        primaryExchange: activeInstrument?.listedExchange ?? '',
        currency: activeInstrument?.currency ?? '',
        assetClass: activeInstrument?.type ?? '',
        interval: '5m',
        startTime: String(startTime),
        endTime: String(endTime),
        barCount: '250',
      })
      const response = await fetch(`/api/v1/ibkr/bars?${params}`, {
        credentials: 'same-origin',
        headers: { 'x-tradescript-client': 'terminal-v1' },
      })
      if (response.ok) {
        const history = (await response.json()) as { bars?: ChartDataRow[] }
        rows = history.bars ?? []
      }
    }
    setChartDataRows(rows.slice(-250).reverse())
    setChartDataOpen(true)
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            TS
          </span>
          <div>
            <strong>TradeScript</strong>
            <span>{MOCK_MODE ? 'Simulated Workstation' : 'IBKR Workstation'}</span>
          </div>
        </div>
        <div className="header-actions">
          {!MOCK_MODE && <ApplicationSettingsButton />}
          <DesktopUpdates />
          {!MOCK_MODE && <ConnectionHealth />}
          {MOCK_MODE && loadState.state !== 'ready' && (
            <span className={`header-status ${loadState.state}`} role="status">
              {loadState.state === 'error' ? 'Unavailable' : 'Connecting…'}
            </span>
          )}
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
            <span>Chart data</span>
          </button>
          {!MOCK_MODE ? (
            <ConnectionSettingsButton />
          ) : (
            <span className="header-simulation">Simulated session</span>
          )}
        </div>
      </header>

      <section className="terminal-frame" aria-busy={loadState.state === 'loading'}>
        <div ref={terminalHost} className="terminal-host" />
        {loadState.state !== 'ready' && (
          <div className={`terminal-overlay ${loadState.state}`} role="status">
            <span className="terminal-loader" aria-hidden="true" />
            <strong>
              {loadState.state === 'error' ? 'Workstation unavailable' : 'Starting workstation'}
            </strong>
            <p>{loadState.message}</p>
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
                <strong id="chart-data-title">{activeInstrument?.ticker} chart data</strong>
                <span>5 minute bars · newest first</span>
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
                      <td>{bar.open.toFixed(2)}</td>
                      <td>{bar.high.toFixed(2)}</td>
                      <td>{bar.low.toFixed(2)}</td>
                      <td>{bar.close.toFixed(2)}</td>
                      <td>{bar.volume?.toLocaleString() ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {chartDataRows.length === 0 && <p>Chart bars are still loading.</p>}
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
