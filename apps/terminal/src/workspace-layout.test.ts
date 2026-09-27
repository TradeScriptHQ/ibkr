import type { PanelLayoutControllerApi } from '@tradescript/pro/sdk/trading'
import { describe, expect, it, vi } from 'vitest'
import { activateWorkstationWidget } from './workspace-layout.js'

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
