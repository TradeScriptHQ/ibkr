import { describe, expect, it } from 'vitest'
import {
  licensedWorkstationSessionMeta,
  licensedWorkstationWidgets,
  WORKSTATION_MESSAGE_AUTO_DISMISS_MS,
  WORKSTATION_WIDGETS,
} from './workstation-widgets.js'

const chartModules = ['terminal', 'chart.core', 'chart.market-data', 'chart']

it('excludes the unlicensed Fundamentals panel before mounting the packaged free workstation', () => {
  const options = licensedWorkstationWidgets({
    modules: [...chartModules, 'watchlist', 'order-ticket', 'account-panel'],
  })
  expect(options.panels).toMatchObject({
    fundamentals: false,
    watchlist: true,
    orderTicket: true,
    accountPanel: true,
    optionChain: false,
  })
  expect(WORKSTATION_WIDGETS.panels?.fundamentals).toBe(true)
})

it('uses verified module grants independently of package tier and preserves granted optional widgets', () => {
  const options = licensedWorkstationWidgets({
    modules: [...chartModules, 'fundamentals', 'option-chain', 'session-badge'],
  })
  expect(options.panels).toMatchObject({ fundamentals: true, optionChain: true, watchlist: false })
  expect(licensedWorkstationSessionMeta({ modules: [...chartModules, 'session-badge'] })).toEqual({
    variant: 'full',
    showHotkeySetupButton: false,
  })
  expect(licensedWorkstationSessionMeta({ modules: chartModules })).toBeUndefined()
})

it('keeps account figures in the portfolio and hosts market status only in the app title bar', () => {
  for (const widgets of [
    WORKSTATION_WIDGETS,
    licensedWorkstationWidgets({
      modules: [...chartModules, 'account-panel', 'account-summary', 'session-badge'],
    }),
  ]) {
    expect(widgets.panels?.accountSummary).toBe(false)
    expect(widgets.statusBarOptions?.session).toBe(false)
    expect(widgets.chartOptions?.features?.sessionBadge).toBe(false)
    expect(widgets.accountPanelOptions?.showAccountTitle).toBe(false)
    expect(widgets.accountPanelOptions?.density).toBe('compact')
  }
  expect(licensedWorkstationSessionMeta(undefined)?.variant).toBe('full')
})

it.each(chartModules)(
  'rejects a customer policy missing mandatory %s before mounting',
  (module) => {
    expect(() =>
      licensedWorkstationWidgets({ modules: chartModules.filter((item) => item !== module) }),
    ).toThrow('SDK access does not include the workstation chart')
  },
)

it('retains explicitly declared source-development panels without claiming a customer lease', () => {
  expect(licensedWorkstationWidgets(undefined)).toBe(WORKSTATION_WIDGETS)
})

it('requests compact top and drawing controls through SDK customization for every workstation chart', () => {
  expect(WORKSTATION_WIDGETS.chartOptions?.initialState?.customization?.toolbar).toMatchObject({
    drawingToolbarVisible: true,
    drawingToolbarSize: 'compact',
    topToolbarSize: 'compact',
  })
  expect(
    licensedWorkstationWidgets({ modules: chartModules }).chartOptions?.initialState?.customization
      ?.toolbar,
  ).toMatchObject({ drawingToolbarSize: 'compact', topToolbarSize: 'compact' })
})

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
