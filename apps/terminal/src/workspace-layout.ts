import type { PanelLayoutControllerApi } from '@tradescript/pro/sdk/trading'

export function activateWorkstationWidget(
  layout: PanelLayoutControllerApi | undefined,
  widgetType: string,
): boolean {
  if (layout === undefined) return false
  const target = layout.listPanels().find((panel) => panel.widgetType === widgetType)
  return target === undefined ? false : layout.activatePanel(target.panelId)
}

export function arrangeDesktopWorkstation(
  layout: PanelLayoutControllerApi,
  host: HTMLDivElement,
): () => void {
  if (host.clientWidth < 1_100) return () => undefined

  const maxWatchlistWidth = 344
  const maxOrderTicketWidth = 400
  const scheduledFrames = new Set<number>()
  let stopped = false
  let removeResizeListener: (() => void) | undefined
  let resizeObserver: ResizeObserver | undefined

  const schedule = (callback: () => void) => {
    const frame = requestAnimationFrame(() => {
      scheduledFrames.delete(frame)
      if (!stopped) callback()
    })
    scheduledFrames.add(frame)
  }

  const panel = (widgetType: string) =>
    layout.listPanels().find((candidate) => candidate.widgetType === widgetType)
  const move = (
    widgetType: string,
    referenceWidgetType: string,
    direction: 'left' | 'right' | 'above' | 'below' | 'within',
  ) => {
    const target = panel(widgetType)
    const reference = panel(referenceWidgetType)
    if (target && reference && target.panelId !== reference.panelId) {
      layout.movePanel(target.panelId, {
        referencePanelId: reference.panelId,
        direction,
      })
    }
  }

  // Start from one group so the top and bottom rows can own independent horizontal splits.
  for (const widgetType of [
    'watchlist',
    'order-ticket',
    'option-chain',
    'option-ticket',
    'depth',
    'account',
    'market-depth',
    'time-and-sales',
    'fundamentals',
    'agent-console',
  ]) {
    move(widgetType, 'chart', 'within')
  }

  // The order rail is the root split. Everything else becomes two separately divided rows.
  move('order-ticket', 'chart', 'right')
  move('account', 'chart', 'below')
  move('watchlist', 'chart', 'left')
  move('market-depth', 'account', 'right')
  move('agent-console', 'order-ticket', 'within')

  const applyPanelSizes = () => {
    const workspaceWidth = host.clientWidth
    const workspaceHeight = host.clientHeight
    const orderTicketWidth = Math.min(Math.round(workspaceWidth * 0.23), maxOrderTicketWidth)
    const watchlistWidth = Math.min(Math.round(workspaceWidth * 0.2), maxWatchlistWidth)
    const resize = (widgetType: string, size: { width?: number; height?: number }) => {
      const target = panel(widgetType)
      if (target) layout.resizePanel(target.panelId, size)
    }

    resize('chart', { width: workspaceWidth - orderTicketWidth - watchlistWidth })
    resize('order-ticket', { width: orderTicketWidth })
    resize('watchlist', { width: watchlistWidth })
    resize('account', {
      width: Math.round(workspaceWidth * 0.46),
      height: Math.round(workspaceHeight * 0.32),
    })
  }

  schedule(() => {
    // Keep alternate tools beside their primary surface rather than consuming a grid cell.
    move('fundamentals', 'chart', 'within')
    move('option-chain', 'chart', 'within')
    move('option-ticket', 'order-ticket', 'within')
    move('depth', 'order-ticket', 'within')
    move('time-and-sales', 'market-depth', 'within')

    for (const widgetType of ['watchlist', 'chart', 'order-ticket', 'account', 'market-depth']) {
      const target = panel(widgetType)
      if (target) layout.activatePanel(target.panelId)
    }

    schedule(() => {
      schedule(() => {
        applyPanelSizes()

        const handleWindowResize = () => {
          if (host.clientWidth < 1_100) return
          schedule(() => schedule(applyPanelSizes))
        }
        window.addEventListener('resize', handleWindowResize)
        removeResizeListener = () => window.removeEventListener('resize', handleWindowResize)
        resizeObserver = new ResizeObserver(() => {
          if (host.clientWidth < 1_100) return
          schedule(() => schedule(applyPanelSizes))
        })
        resizeObserver.observe(host)
      })
    })
  })

  return () => {
    stopped = true
    removeResizeListener?.()
    resizeObserver?.disconnect()
    for (const frame of scheduledFrames) cancelAnimationFrame(frame)
    scheduledFrames.clear()
  }
}
