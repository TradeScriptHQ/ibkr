import type {
  ChartAuthorizationSnapshot,
  SymbolInfo,
  SymbolSearchSavedView,
} from '@tradescript/pro/sdk'
import type { createTerminalTradeScriptSdk } from './terminal-session.js'

export const WORKSTATION_MESSAGE_AUTO_DISMISS_MS = 5_000

const WORKSTATION_TOOLBAR = Object.freeze({
  drawingToolbarVisible: true,
  drawingToolbarSize: 'compact',
  topToolbarSize: 'compact',
})

export type WorkstationMountOptions = Parameters<
  Awaited<ReturnType<typeof createTerminalTradeScriptSdk>>['tradingTerminal']['mount']
>[0]
export const WORKSTATION_WIDGETS: Pick<
  WorkstationMountOptions,
  | 'interval'
  | 'theme'
  | 'panels'
  | 'labels'
  | 'orderTicketOptions'
  | 'accountPanelOptions'
  | 'optionChainOptions'
  | 'timeAndSalesOptions'
  | 'statusBarOptions'
  | 'chartOptions'
  | 'layoutOptions'
> = {
  interval: '5m',
  panels: {
    orderTicket: true,
    accountPanel: true,
    accountSummary: false,
    watchlist: true,
    depthLadder: true,
    marketDepth: true,
    timeAndSales: true,
    fundamentals: true,
    optionChain: true,
    optionTicket: true,
    agentConsole: true,
  },
  labels: {
    chartTitle: 'IBKR Chart',
    orderTicketTitle: 'Order Entry',
    accountPanelTitle: 'Portfolio & Activity',
    depthLadderTitle: 'Price Ladder',
    marketDepthTitle: 'Order Book',
    timeAndSalesTitle: 'Time & Sales',
    watchlistTitle: 'Markets',
    optionChainTitle: 'Options Chain',
    optionTicketTitle: 'Options Order',
    agentConsoleTitle: 'Agent Console',
  },
  orderTicketOptions: {
    defaultQuantity: 1,
    orderPreviewMode: 'dialog',
    labels: { commission: 'Entry commission' },
    options: { defaultOrderOptionsExpanded: false },
    messageAutoDismissMs: WORKSTATION_MESSAGE_AUTO_DISMISS_MS,
    directionSelector: { layout: 'split', order: 'buy-sell' },
    slotClassNames: { previewWarning: 'ticket-warning' },
    slotStyles: {
      root: { gap: '16px' },
      quoteTile: ({ active }) => (active ? undefined : { background: 'transparent' }),
      estimatedRow: { paddingInline: '12px' },
      commissionRow: { paddingInline: '12px' },
      cashRow: { paddingInline: '12px' },
      orderInfoRow: { paddingInline: '12px' },
    },
  },
  accountPanelOptions: {
    showAccountTitle: false,
    density: 'compact',
    defaultPageId: 'positions',
    messageAutoDismissMs: WORKSTATION_MESSAGE_AUTO_DISMISS_MS,
  },
  optionChainOptions: {
    defaultStrikeRows: 20,
    columns: [
      'last',
      'volume',
      'impliedVolatility',
      'delta',
      'gamma',
      'theta',
      'vega',
      'bid',
      'ask',
    ],
  },
  timeAndSalesOptions: {
    maxRows: 200,
    labels: {
      waiting: 'Tick-by-tick data unavailable · IBKR live subscription required',
      error: 'IBKR tick-by-tick data is unavailable for this session',
    },
  },
  statusBarOptions: { session: false },
  chartOptions: {
    features: { sessionBadge: false },
    accessibility: { dataTable: true },
    initialState: {
      customization: {
        toolbar: WORKSTATION_TOOLBAR,
        chartOverrides: {
          grid: {
            show: true,
            horizontal: { show: true, hairline: true, opacity: 1 },
            vertical: { show: true, hairline: true, opacity: 1 },
            verticalMinor: { show: true, hairline: true, opacity: 1 },
            verticalMajor: { show: true, hairline: true, opacity: 1 },
          },
          sessions: {
            show: true,
            regular: { opacity: 0 },
            breakLines: { show: true, size: 1, opacity: 0.13 },
          },
        },
      },
    },
  },
  layoutOptions: {
    showAddWidgetAction: true,
    showMaximizeAction: true,
    showCloseAction: true,
    resizable: false,
  },
}

/** Select host-requested panels from the verified public SDK policy before mounting. */
export function licensedWorkstationWidgets(
  policy: Pick<ChartAuthorizationSnapshot['policy'], 'modules'> | undefined,
): typeof WORKSTATION_WIDGETS {
  // Only the explicit source development facade has no customer lease authority.
  if (policy === undefined) return WORKSTATION_WIDGETS
  const grants = new Set(policy.modules)
  if (
    !['terminal', 'chart.core', 'chart.market-data', 'chart'].every((module) => grants.has(module))
  )
    throw new Error(
      'SDK access does not include the workstation chart. Restore SDK access and retry.',
    )
  return {
    ...WORKSTATION_WIDGETS,
    panels: {
      orderTicket: grants.has('order-ticket'),
      accountPanel: grants.has('account-panel'),
      accountSummary: false,
      watchlist: grants.has('watchlist'),
      depthLadder: grants.has('depth-ladder'),
      marketDepth: grants.has('market-depth'),
      timeAndSales: grants.has('time-and-sales'),
      fundamentals: grants.has('fundamentals'),
      optionChain: grants.has('option-chain'),
      optionTicket: grants.has('option-ticket'),
      agentConsole: true,
    },
  }
}

/** Host the SDK session badge once in the app title bar when the verified policy permits it. */
export function licensedWorkstationSessionMeta(
  policy: Pick<ChartAuthorizationSnapshot['policy'], 'modules'> | undefined,
) {
  if (policy !== undefined && !policy.modules.includes('session-badge')) return undefined
  return { variant: 'full' as const, showHotkeySetupButton: false }
}

/** Symbol-picker presets owned by the active market-data provider. */
export interface SymbolSearchPresets {
  savedViews?: SymbolSearchSavedView[]
  /** The provider's own search rows, listed before the user types. */
  defaultSymbols: readonly SymbolInfo[]
}

/** Adds the active provider's symbol-picker presets to the workstation chart. */
export function withSymbolSearchPresets(
  widgets: typeof WORKSTATION_WIDGETS,
  presets: SymbolSearchPresets,
): typeof WORKSTATION_WIDGETS {
  return {
    ...widgets,
    chartOptions: {
      ...widgets.chartOptions,
      features: {
        ...widgets.chartOptions?.features,
        symbolSearch: {
          ...(presets.savedViews ? { savedViews: presets.savedViews } : {}),
          defaultSymbols: [...presets.defaultSymbols],
        },
      },
    },
  }
}
