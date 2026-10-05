import type { SdkSymbolInfo } from '@tradescript/pro/sdk'
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppearanceStore } from './appearance-ui.js'
import { subscribeBrowserSessionChanges } from './terminal-session.js'
import { type ChartDataSnapshot, createWorkstation, type LoadState } from './workstation.js'
import { workstationLoading } from './workstation-startup.js'

export type { ChartDataRow, ChartDataSnapshot, LoadState } from './workstation.js'

export function useWorkstation(
  terminalHost: RefObject<HTMLDivElement | null>,
  sessionMetaHost: RefObject<HTMLDivElement | null>,
  chartBarsReader: RefObject<() => ChartDataSnapshot>,
  setActiveInstrument: (symbol: SdkSymbolInfo) => void,
  setupReady: boolean,
): LoadState & { retry(): void } {
  const appearance = useAppearanceStore()
  const [attempt, setAttempt] = useState(0)
  const pendingDisposal = useRef(Promise.resolve())
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  const [loadState, setLoadState] = useState<LoadState>(
    workstationLoading(setupReady ? 'authorization' : 'setup'),
  )
  useEffect(() => subscribeBrowserSessionChanges(retry), [retry])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter deliberately starts a new workstation lifetime.
  useEffect(() => {
    if (!setupReady) {
      setLoadState(workstationLoading('setup'))
      return
    }
    setLoadState(workstationLoading('authorization'))
    let closed = false
    let workstation: ReturnType<typeof createWorkstation> | undefined
    const start = async () => {
      await pendingDisposal.current
      if (closed) return
      workstation = createWorkstation({
        appearance,
        host: terminalHost.current,
        sessionMetaHost: sessionMetaHost.current,
        setChartBarsReader: (reader) => {
          chartBarsReader.current = reader
        },
        setActiveInstrument,
        setLoadState,
        mockMode: import.meta.env.VITE_TRADING_MODE === 'mock',
      })
    }
    void start()
    return () => {
      closed = true
      if (workstation)
        pendingDisposal.current = Promise.all([workstation.dispose(), workstation.started]).then(
          () => undefined,
        )
    }
  }, [
    appearance,
    terminalHost,
    sessionMetaHost,
    chartBarsReader,
    setActiveInstrument,
    attempt,
    setupReady,
  ])
  return { ...loadState, retry }
}
