import type { SdkSymbolInfo } from '@tradescript/pro/sdk'
import type { RefObject } from 'react'
import { useEffect, useState } from 'react'
import { type ChartDataRow, createWorkstation, type LoadState } from './workstation.js'

export type { ChartDataRow, LoadState } from './workstation.js'

export function useWorkstation(
  terminalHost: RefObject<HTMLDivElement | null>,
  chartBarsReader: RefObject<() => ChartDataRow[]>,
  setActiveInstrument: (symbol: SdkSymbolInfo) => void,
): LoadState {
  const [loadState, setLoadState] = useState<LoadState>({
    state: 'loading',
    message: 'Authorizing the local TradeScript workstation…',
  })
  useEffect(() => {
    const workstation = createWorkstation({
      host: terminalHost.current,
      setChartBarsReader: (reader) => {
        chartBarsReader.current = reader
      },
      setActiveInstrument,
      setLoadState,
      mockMode: import.meta.env.VITE_TRADING_MODE === 'mock',
    })
    return () => {
      void workstation.dispose()
    }
  }, [terminalHost, chartBarsReader, setActiveInstrument])
  return loadState
}
