import type { PanelLayoutControllerApi } from '@tradescript/pro/sdk/trading'
import { resizeDesktopWorkstation } from './workspace-layout.js'

export const WORKSPACE_PRESETS = [
  { id: 'stocks', name: 'Stocks', description: 'Chart, watchlist, fundamentals, and order entry.' },
  {
    id: 'options',
    name: 'Options',
    description: 'Option chain and contract charts, with options orders on the right.',
  },
  {
    id: 'active',
    name: 'Active Trading',
    description: 'Chart, market depth, time and sales, and price ladder.',
  },
  {
    id: 'charts',
    name: 'Chart Analysis',
    description: 'More room for the chart, with research and activity nearby.',
  },
  {
    id: 'portfolio',
    name: 'Portfolio',
    description: 'Positions and order activity take center stage.',
  },
] as const

export type WorkspacePresetId = (typeof WORKSPACE_PRESETS)[number]['id']
export type WorkspaceLayoutController = Pick<
  PanelLayoutControllerApi,
  | 'listPanels'
  | 'addWidget'
  | 'closePanel'
  | 'restorePanel'
  | 'movePanel'
  | 'resizePanel'
  | 'activatePanel'
  | 'savePanelArrangement'
  | 'loadPanelArrangement'
>

export function isWorkspacePresetId(id: string): id is WorkspacePresetId {
  return WORKSPACE_PRESETS.some((preset) => preset.id === id)
}

/** Use the public semantic controller; the SDK owns its serialized layout format. */
export function arrangeWorkspacePreset(
  id: WorkspacePresetId,
  layout: WorkspaceLayoutController,
  host: Pick<HTMLDivElement, 'clientWidth' | 'clientHeight'>,
  availableWidgets: readonly string[],
  onComplete: () => void,
): () => void {
  let stopped = false
  const frames = new Set<number>()
  const schedule = (callback: () => void) => {
    const frame = requestAnimationFrame(() => {
      frames.delete(frame)
      if (!stopped) callback()
    })
    frames.add(frame)
  }
  const panel = (type: string) => layout.listPanels().find((item) => item.widgetType === type)
  const move = (
    type: string,
    reference: string,
    direction: 'left' | 'right' | 'above' | 'below' | 'within',
  ) => {
    const target = panel(type)
    const anchor = panel(reference)
    if (target && anchor && target.panelId !== anchor.panelId) {
      layout.movePanel(target.panelId, { referencePanelId: anchor.panelId, direction })
    }
  }
  const resize = (type: string, size: { width?: number; height?: number }) => {
    const target = panel(type)
    if (target) layout.resizePanel(target.panelId, size)
  }

  // A factory preset restores closed tools that were available in this licensed workstation.
  for (const type of availableWidgets) {
    if (type !== 'contract-chart' && !panel(type)) layout.addWidget(type)
  }
  const anchor = panel('chart') ?? layout.listPanels()[0]
  if (!anchor) {
    onComplete()
    return () => undefined
  }
  for (const item of layout.listPanels()) {
    if (item.maximized) layout.restorePanel(item.panelId)
    if (item.widgetType === 'contract-chart') layout.closePanel(item.panelId)
    else if (item.panelId !== anchor.panelId) {
      layout.movePanel(item.panelId, { referencePanelId: anchor.panelId, direction: 'within' })
    }
  }

  // Always put order entry on the far right. Only the central analysis region is split
  // when the SDK opens a contract chart from an option quote.
  move('order-ticket', 'chart', 'right')
  move('option-ticket', 'order-ticket', 'within')
  move('depth', 'order-ticket', 'within')
  move('agent-console', 'order-ticket', 'within')
  move('watchlist', 'chart', 'left')

  if (id === 'active') {
    move('account', 'chart', 'below')
    move('market-depth', 'chart', 'right')
    move('time-and-sales', 'market-depth', 'below')
    move('fundamentals', 'watchlist', 'within')
  } else if (id === 'portfolio') {
    move('account', 'chart', 'above')
    move('fundamentals', 'watchlist', 'within')
    move('market-depth', 'chart', 'within')
    move('time-and-sales', 'chart', 'within')
  } else {
    move('account', 'chart', 'below')
    move('fundamentals', 'watchlist', 'below')
    if (id === 'charts') {
      move('market-depth', 'account', 'within')
      move('time-and-sales', 'account', 'within')
    } else {
      move('market-depth', 'account', 'right')
      move('time-and-sales', 'market-depth', 'within')
    }
  }
  move('option-chain', 'chart', 'within')

  schedule(() =>
    schedule(() => {
      const width = host.clientWidth
      const height = host.clientHeight
      if (width >= 1_100 && (id === 'stocks' || id === 'options')) {
        resizeDesktopWorkstation(layout, host, 0.4)
      } else {
        resize('order-ticket', { width: Math.min(Math.round(width * 0.23), 400) })
        resize('watchlist', {
          width: Math.min(Math.round(width * (id === 'charts' ? 0.17 : 0.2)), 344),
        })
        resize('account', {
          height: Math.round(height * (id === 'portfolio' ? 0.7 : id === 'charts' ? 0.19 : 0.27)),
        })
        if (id === 'active') {
          resize('market-depth', { width: Math.round(width * 0.23) })
          resize('time-and-sales', { height: Math.round(height * 0.38) })
        }
      }
      for (const type of [
        'fundamentals',
        'watchlist',
        'time-and-sales',
        'market-depth',
        'chart',
        'account',
        id === 'options' ? 'option-chain' : 'chart',
        id === 'options' ? 'option-ticket' : id === 'active' ? 'depth' : 'order-ticket',
      ]) {
        const target = panel(type)
        if (target) layout.activatePanel(target.panelId)
      }
      // Let the engine finish its layout pass before recording the factory baseline.
      schedule(onComplete)
    }),
  )

  // Sizing is an initial preset operation. Native resizing must retain user proportions.
  return () => {
    stopped = true
    for (const frame of frames) cancelAnimationFrame(frame)
    frames.clear()
  }
}
