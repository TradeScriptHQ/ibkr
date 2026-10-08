import type { PanelLayoutControllerApi, PanelLayoutPanelState } from '@tradescript/pro/sdk/trading'
import { describe, expect, it, vi } from 'vitest'
import { activateWorkstationWidget, resizeDesktopWorkstation } from './workspace-layout.js'

describe('workstation widget activation', () => {
  it('foregrounds the panel that owns the requested widget', () => {
    const activatePanel = vi.fn(() => true)
    const layout = {
      listPanels: () => [
        { panelId: 'chart-panel', widgetType: 'chart' },
        { panelId: 'options-order-panel', widgetType: 'option-ticket' },
      ],
      activatePanel,
    } as unknown as PanelLayoutControllerApi

    expect(activateWorkstationWidget(layout, 'option-ticket')).toBe(true)
    expect(activatePanel).toHaveBeenCalledOnce()
    expect(activatePanel).toHaveBeenCalledWith('options-order-panel')
  })

  it('does nothing when the requested widget is not in the layout', () => {
    const activatePanel = vi.fn(() => true)
    const layout = {
      listPanels: () => [{ panelId: 'chart-panel', widgetType: 'chart' }],
      activatePanel,
    } as unknown as PanelLayoutControllerApi

    expect(activateWorkstationWidget(layout, 'option-ticket')).toBe(false)
    expect(activatePanel).not.toHaveBeenCalled()
  })
})

describe('desktop workstation sizing', () => {
  const panel = (
    widgetType: string,
    location: PanelLayoutPanelState['location'] = 'grid',
  ): PanelLayoutPanelState => ({
    panelId: `${widgetType}-panel`,
    widgetType,
    title: widgetType,
    groupId: `${widgetType}-group`,
    params: {},
    active: false,
    maximized: false,
    location,
    width: 0,
    height: 0,
  })

  it.each([1_280, 1_920])(
    'shares the analysis area at 60/40 at a workspace width of %i',
    (clientWidth) => {
      const resizePanel = vi.fn(() => true)
      resizeDesktopWorkstation(
        {
          listPanels: () =>
            ['chart', 'contract-chart', 'watchlist', 'order-ticket', 'account'].map((type) =>
              panel(type),
            ),
          resizePanel,
        },
        { clientWidth, clientHeight: 800 },
        0.4,
      )

      const orderWidth = Math.min(Math.round(clientWidth * 0.23), 400)
      const watchlistWidth = Math.min(Math.round(clientWidth * 0.2), 344)
      const analysisWidth = clientWidth - orderWidth - watchlistWidth
      const chartWidth = Math.round(analysisWidth * 0.4)
      expect(resizePanel).toHaveBeenCalledWith('chart-panel', { width: analysisWidth - chartWidth })
      expect(resizePanel).toHaveBeenCalledWith('contract-chart-panel', { width: chartWidth })
      expect(resizePanel).toHaveBeenCalledWith('order-ticket-panel', { width: orderWidth })
    },
  )

  it.each(['closed', 'floating'] as const)(
    'gives the chain the full analysis area when the contract chart is %s',
    (state) => {
      const resizePanel = vi.fn(() => true)
      resizeDesktopWorkstation(
        {
          listPanels: () => [
            panel('chart'),
            ...(state === 'floating' ? [panel('contract-chart', 'floating')] : []),
          ],
          resizePanel,
        },
        { clientWidth: 1_280, clientHeight: 800 },
        0.4,
      )

      expect(resizePanel).toHaveBeenCalledWith('chart-panel', { width: 730 })
      expect(resizePanel).not.toHaveBeenCalledWith('contract-chart-panel', expect.anything())
    },
  )
})
