import type { createTerminalTradeScriptSdk } from './terminal-session.js'
import { WORKSTATION_THEME } from './workstation-theme.js'

export const WORKSTATION_MESSAGE_AUTO_DISMISS_MS = 5_000

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
  theme: WORKSTATION_THEME,
  panels: {
    orderTicket: true,
    accountPanel: true,
    accountSummary: true,
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
  statusBarOptions: { session: true },
  chartOptions: { accessibility: { dataTable: true } },
  layoutOptions: {
    showAddWidgetAction: true,
    showMaximizeAction: true,
    showCloseAction: true,
    resizable: false,
  },
}

export function applyChartAppearance(
  widget: Parameters<NonNullable<WorkstationMountOptions['onReady']>>[0],
): void {
  const customization = widget.customization()
  const background = {
    type: 'vertical-gradient' as const,
    color: 'rgba(7, 17, 27, 0.22)',
    gradientStartColor: 'rgba(10, 26, 41, 0.22)',
    gradientEndColor: 'rgba(5, 12, 19, 0.3)',
  }
  const grid = {
    show: true,
    horizontal: {
      show: true,
      color: '#789dbf',
      hairline: true,
      opacity: 0.075,
    },
    vertical: {
      show: true,
      color: '#789dbf',
      hairline: true,
      opacity: 0.052,
    },
    verticalMinor: {
      show: true,
      color: '#789dbf',
      hairline: true,
      opacity: 0.028,
    },
    verticalMajor: {
      show: true,
      color: '#789dbf',
      hairline: true,
      opacity: 0.08,
    },
  }
  void customization.applyOverrides({
    chart: { background },
    grid,
    sessions: {
      show: true,
      premarket: { color: '#244563', opacity: 0.16 },
      regular: { color: '#07111b', opacity: 0 },
      afterhours: { color: '#294867', opacity: 0.18 },
      breakLines: {
        show: true,
        color: '#789dbf',
        opacity: 0.13,
        size: 1,
      },
    },
  })
  void customization.applyStyleOverrides({
    background: {
      ...background,
    },
    grid,
  })
}
