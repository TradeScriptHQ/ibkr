import { describe, expect, it } from 'vitest'
import { WORKSTATION_MESSAGE_AUTO_DISMISS_MS, WORKSTATION_WIDGETS } from './workstation-widgets.js'

describe('workstation message lifetime', () => {
  it('dismisses transient order and account messages after five seconds', () => {
    expect(WORKSTATION_MESSAGE_AUTO_DISMISS_MS).toBe(5_000)
    expect(WORKSTATION_WIDGETS.orderTicketOptions?.messageAutoDismissMs).toBe(
      WORKSTATION_MESSAGE_AUTO_DISMISS_MS,
    )
    expect(WORKSTATION_WIDGETS.accountPanelOptions?.messageAutoDismissMs).toBe(
      WORKSTATION_MESSAGE_AUTO_DISMISS_MS,
    )
  })

  it('shows the TWS model Greeks in the option chain', () => {
    expect(WORKSTATION_WIDGETS.optionChainOptions?.columns).toEqual([
      'last',
      'volume',
      'impliedVolatility',
      'delta',
      'gamma',
      'theta',
      'vega',
      'bid',
      'ask',
    ])
  })
})
