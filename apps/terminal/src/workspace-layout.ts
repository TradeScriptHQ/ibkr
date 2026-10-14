import type { PanelLayoutControllerApi } from '@tradescript/pro/sdk/trading'

export function activateWorkstationWidget(
  layout: PanelLayoutControllerApi | undefined,
  widgetType: string,
): boolean {
  if (layout === undefined) return false
  const target = layout.listPanels().find((panel) => panel.widgetType === widgetType)
  return target === undefined ? false : layout.activatePanel(target.panelId)
}

export function resizeDesktopWorkstation(
  layout: Pick<PanelLayoutControllerApi, 'listPanels' | 'resizePanel'>,
  host: Pick<HTMLDivElement, 'clientWidth' | 'clientHeight'>,
  contractChartWidthFraction: number,
): void {
  const panels = layout.listPanels()
  const orderTicketWidth = Math.min(Math.round(host.clientWidth * 0.23), 400)
  const watchlistWidth = Math.min(Math.round(host.clientWidth * 0.2), 344)
  const analysisWidth = host.clientWidth - orderTicketWidth - watchlistWidth
  const contractChart = panels.find(
    (panel) => panel.widgetType === 'contract-chart' && panel.location === 'grid',
  )
  const contractChartWidth = contractChart
    ? Math.round(analysisWidth * contractChartWidthFraction)
    : 0
  const resize = (widgetType: string, size: { width?: number; height?: number }) => {
    const target = panels.find((panel) => panel.widgetType === widgetType)
    if (target) layout.resizePanel(target.panelId, size)
  }

  resize('chart', { width: analysisWidth - contractChartWidth })
  if (contractChart) layout.resizePanel(contractChart.panelId, { width: contractChartWidth })
  resize('account', {
    width: Math.round(analysisWidth * 0.52),
    height: Math.round(host.clientHeight * 0.32),
  })
  resize('watchlist', { width: watchlistWidth })
  resize('order-ticket', { width: orderTicketWidth })
}
