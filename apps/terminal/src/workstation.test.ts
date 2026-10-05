import { afterEach, expect, it, vi } from 'vitest'
import { createAppearanceStore } from './appearance.js'
import type { createTerminalTradeScriptSdk } from './terminal-session.js'
import { createWorkstation, initializeWorkstationTrading } from './workstation.js'
import { WORKSTATION_THEMES } from './workstation-theme.js'

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  sdk: vi.fn(),
  remove: vi.fn(),
  adapter: vi.fn(),
  broker: vi.fn(),
  datafeed: vi.fn(),
  watchlist: vi.fn(),
  mcp: vi.fn(),
  risk: vi.fn(),
}))
vi.mock('@tradescript/pro/sdk', async (original) => ({
  ...(await original<typeof import('@tradescript/pro/sdk')>()),
  createTradeScriptAdapter: mocks.adapter,
}))
vi.mock('./ibkr/http-broker-adapter.js', () => ({
  createIbkrHttpBrokerAdapter: mocks.broker,
}))
vi.mock('./ibkr/market-datafeed.js', () => ({ createIbkrMarketDatafeed: mocks.datafeed }))
vi.mock('./watchlist.js', () => ({ createLocalWatchlistAdapter: mocks.watchlist }))
vi.mock('./mcp/browser-bridge.js', () => ({ connectTradeScriptMcp: mocks.mcp }))
vi.mock('./risk.js', () => ({ createConnectionRiskAuthority: mocks.risk }))
vi.mock('./workstation-authorization.js', () => ({ authorizeWorkstation: mocks.authorize }))
vi.mock('./terminal-session.js', () => ({ createTerminalTradeScriptSdk: mocks.sdk }))
vi.mock('./workstation-e2e.js', () => ({
  removeWorkstationE2e: mocks.remove,
  installWorkstationE2e: vi.fn(),
}))

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function options() {
  return {
    appearance: createAppearanceStore(),
    host: {} as HTMLDivElement,
    sessionMetaHost: null as HTMLDivElement | null,
    setChartBarsReader: vi.fn(),
    setActiveInstrument: vi.fn(),
    setLoadState: vi.fn(),
    mockMode: false,
  }
}

function mountedWorkstation(riskResult: unknown, enabled = true) {
  const symbol = {
    ticker: 'MSFT',
    brokerSymbol: 'MSFT',
    canonicalSymbol: 'test:MSFT',
    exchange: 'SMART',
    currency: 'USD',
    type: 'stock' as const,
  }
  mocks.authorize.mockResolvedValue({
    session: {},
    status: { environment: 'paper' },
    bootstrap: { lease: 'test', paperTrading: { autonomyMode: 'paper-auto' } },
    connection: {
      settings: {
        active: 'paper',
        profiles: {
          paper: { agentTradingEnabled: enabled, allowedAccountIds: ['paper-fixture'], limits: {} },
        },
      },
    },
  })
  vi.stubGlobal('document', { title: '' })
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
  const stopQuotes = vi.fn(),
    stopDepth = vi.fn(),
    stopSymbol = vi.fn()
  const marketData = {
    destroy: vi.fn(),
    getQuotes: vi.fn().mockResolvedValue([]),
    subscribeQuotes: vi.fn(() => stopQuotes),
    subscribeDepth: vi.fn(() => stopDepth),
  }
  const symbolLink = {
    destroy: vi.fn(),
    getSymbol: () => symbol,
    subscribe: vi.fn((_receive: (value: typeof symbol) => void) => stopSymbol),
  }
  mocks.risk.mockReturnValue(riskResult)
  mocks.broker.mockReturnValue({})
  mocks.datafeed.mockReturnValue({ resolveSymbol: vi.fn().mockResolvedValue(symbol) })
  mocks.watchlist.mockResolvedValue({})
  mocks.mcp.mockImplementation(() => ({ dispose: vi.fn(), replaceAgentic: vi.fn() }))
  const trading = () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({ connectionStatus: 'connected' }),
    getOperationSupport: vi.fn(() => ({})),
    disconnect: vi.fn().mockResolvedValue(undefined),
  })
  mocks.adapter.mockImplementation((configuration) => ({
    marketData: configuration.marketData.controller ?? marketData,
    symbolLink: configuration.symbolLink ?? symbolLink,
    trading: trading(),
    destroy: vi.fn(),
    agentic: { getAccessPolicy: () => configuration.agenticAccess },
  }))
  type MountOptions = Parameters<
    Awaited<ReturnType<typeof createTerminalTradeScriptSdk>>['tradingTerminal']['mount']
  >[0]
  let mountedOptions: MountOptions
  const update = vi.fn((next: Partial<MountOptions>) => {
    if (!next.adapter) return
    mountedOptions.onTerminalReady?.({
      adapter: next.adapter,
      trading: next.adapter.trading,
    } as Parameters<NonNullable<MountOptions['onTerminalReady']>>[0])
  })
  const destroy = vi.fn(),
    close = vi.fn()
  const sessionMetaUpdate = vi.fn(),
    sessionMetaDestroy = vi.fn()
  const sessionMetaMount = vi.fn(() => ({ update: sessionMetaUpdate, destroy: sessionMetaDestroy }))
  const mount = vi.fn((configuration: MountOptions) => {
    mountedOptions = configuration
    configuration.onTerminalReady?.({
      adapter: configuration.adapter,
      trading: configuration.adapter?.trading,
    } as Parameters<NonNullable<MountOptions['onTerminalReady']>>[0])
    return { update, destroy }
  })
  mocks.sdk.mockResolvedValue({
    close,
    marketData: { createController: () => marketData },
    symbols: { createLinkController: () => symbolLink },
    tradingTerminal: { mount },
    sessionMeta: { mount: sessionMetaMount },
  })
  const props = options()
  props.host = { dataset: {} } as HTMLDivElement
  props.sessionMetaHost = {} as HTMLDivElement
  return {
    props,
    symbol,
    mount,
    update,
    destroy,
    close,
    stopQuotes,
    stopDepth,
    marketData,
    symbolLink,
    sessionMetaMount,
    sessionMetaUpdate,
    sessionMetaDestroy,
    workstation: createWorkstation(props),
  }
}

it('mounts the title-bar session badge on the shared market controller and follows instrument, theme and lifetime', async () => {
  const fixture = mountedWorkstation(undefined, false)
  try {
    await fixture.workstation.started
    expect(fixture.sessionMetaMount).toHaveBeenCalledOnce()
    expect(fixture.sessionMetaMount).toHaveBeenCalledWith(
      expect.objectContaining({
        mount: fixture.props.sessionMetaHost,
        controller: fixture.marketData,
        symbol: fixture.symbol,
        variant: 'full',
        showHotkeySetupButton: false,
      }),
    )
    expect(fixture.mount.mock.calls[0]?.[0].accountPanelOptions?.showAccountTitle).toBe(false)
    const next = {
      ...fixture.symbol,
      ticker: 'AAPL',
      brokerSymbol: 'AAPL',
      canonicalSymbol: 'test:AAPL',
    }
    for (const [receive] of fixture.symbolLink.subscribe.mock.calls) receive(next)
    expect(fixture.sessionMetaUpdate).toHaveBeenCalledWith({ symbol: next })
    expect(fixture.props.setActiveInstrument).toHaveBeenCalledWith(next)
    fixture.props.appearance.set('light')
    expect(fixture.sessionMetaUpdate).toHaveBeenCalledWith({
      theme: WORKSTATION_THEMES.light,
    })
  } finally {
    await fixture.workstation.dispose()
  }
  expect(fixture.sessionMetaDestroy).toHaveBeenCalledOnce()
  const updates = fixture.sessionMetaUpdate.mock.calls.length
  fixture.props.appearance.set('dark')
  expect(fixture.sessionMetaUpdate).toHaveBeenCalledTimes(updates)
})

it('opens the workstation while agent checks are pending and attaches verified authority without remounting', async () => {
  const pending = Promise.withResolvers<{
    controller: object
    requests: object
    destroy: ReturnType<typeof vi.fn>
  }>()
  const authority = { controller: {}, requests: {}, destroy: vi.fn() }
  const fixture = mountedWorkstation(pending.promise)
  try {
    await vi.waitFor(() => expect(fixture.mount).toHaveBeenCalledOnce(), { timeout: 500 })
    await fixture.workstation.started
    await vi.waitFor(() =>
      expect(fixture.props.setLoadState).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'ready', agentRisk: { state: 'checking' } }),
      ),
    )
    expect(mocks.adapter).toHaveBeenCalledTimes(1)
    expect(mocks.adapter.mock.calls[0]?.[0].agenticAccess.trade).toBe(false)
    pending.resolve(authority)
    await vi.waitFor(() =>
      expect(fixture.props.setLoadState).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'ready', agentRisk: { state: 'ready' } }),
      ),
    )
    expect(fixture.mount).toHaveBeenCalledOnce()
    expect(mocks.adapter).toHaveBeenCalledTimes(2)
    expect(mocks.adapter.mock.calls[1]?.[0]).toMatchObject({
      marketData: { controller: fixture.marketData },
      symbolLink: fixture.symbolLink,
      risk: authority.controller,
      riskRequests: authority.requests,
      agenticAccess: { read: true, write: true, trade: { mode: 'paper' } },
    })
    expect(fixture.update).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: mocks.adapter.mock.results[1]?.value }),
    )
    expect(mocks.mcp).toHaveBeenCalledOnce()
    expect(mocks.mcp.mock.results[0]?.value.replaceAgentic).toHaveBeenCalledWith(
      mocks.adapter.mock.results[1]?.value.agentic,
    )
  } finally {
    pending.resolve(authority)
    await fixture.workstation.started
    await fixture.workstation.dispose()
  }
  expect(authority.destroy).toHaveBeenCalledOnce()
})

it('releases an SDK that finishes loading after the workstation is disposed', async () => {
  mocks.authorize.mockResolvedValue({
    session: {},
    status: { environment: 'paper' },
    bootstrap: { lease: 'test' },
  })
  vi.stubGlobal('document', { title: '' })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof createTerminalTradeScriptSdk>>>()
  mocks.sdk.mockReturnValue(pending.promise)
  const props = options()
  const workstation = createWorkstation(props)
  await vi.waitFor(() => expect(mocks.sdk).toHaveBeenCalledOnce())
  expect(props.setLoadState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      state: 'loading',
      progress: { stage: 'sdk', completed: 3, total: 8 },
    }),
  )
  await workstation.dispose()
  const close = vi.fn()
  const mount = vi.fn()
  // Only teardown may touch this late SDK; mounting it would be a lifecycle regression.
  pending.resolve({ close, tradingTerminal: { mount } } as unknown as Awaited<
    ReturnType<typeof createTerminalTradeScriptSdk>
  >)
  await workstation.started
  await workstation.dispose()
  expect(close).toHaveBeenCalledOnce()
  expect(mount).not.toHaveBeenCalled()
  expect(mocks.remove).toHaveBeenCalledOnce()
  expect(props.setLoadState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'ready' }))
})

it('aborts authorization and prevents startup from publishing errors after disposal', async () => {
  const pending = Promise.withResolvers<never>()
  mocks.authorize.mockReturnValue(pending.promise)
  const props = options()
  const workstation = createWorkstation(props)
  const signal = mocks.authorize.mock.calls[0]?.[0] as AbortSignal
  await workstation.dispose()
  expect(signal.aborted).toBe(true)
  pending.reject(new Error('late authorization failure'))
  await workstation.started
  expect(props.setLoadState).not.toHaveBeenCalled()
  expect(mocks.sdk).not.toHaveBeenCalled()
})

it('releases risk authority that finishes after disposal without updating the mount or granting trade', async () => {
  const pending = Promise.withResolvers<{
    controller: object
    requests: object
    destroy: ReturnType<typeof vi.fn>
  }>()
  const fixture = mountedWorkstation(pending.promise)
  const { props, workstation, mount, close } = fixture
  await vi.waitFor(() => expect(mocks.risk).toHaveBeenCalledOnce())
  await workstation.started
  expect(props.setLoadState).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'ready', agentRisk: { state: 'checking' } }),
  )
  expect(mount).toHaveBeenCalledOnce()
  await workstation.dispose()
  const updates = fixture.update.mock.calls.length
  const publications = props.setLoadState.mock.calls.length
  const authority = { controller: {}, requests: {}, destroy: vi.fn() }
  pending.resolve(authority)
  await vi.waitFor(() => expect(authority.destroy).toHaveBeenCalledOnce())
  expect(mount).toHaveBeenCalledOnce()
  expect(fixture.update).toHaveBeenCalledTimes(updates)
  expect(props.setLoadState).toHaveBeenCalledTimes(publications)
  expect(mocks.adapter).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
  expect(mocks.adapter.mock.calls[0]?.[0].agenticAccess.trade).toBe(false)
})

it('reports startup failures and releases the attempt without waiting for React to unmount', async () => {
  mocks.authorize.mockRejectedValue(new Error('Gateway unavailable'))
  const props = options()
  const workstation = createWorkstation(props)
  await workstation.started
  expect(props.setLoadState).toHaveBeenCalledWith({
    state: 'error',
    message: 'Gateway unavailable',
  })
  expect(mocks.remove).toHaveBeenCalledOnce()
  await workstation.dispose()
  expect(mocks.remove).toHaveBeenCalledOnce()
})

it('reports a known license failure before mounting or publishing ready', async () => {
  mocks.authorize.mockResolvedValue({
    session: {},
    status: { environment: 'paper' },
    bootstrap: { lease: 'test' },
  })
  vi.stubGlobal('document', { title: '' })
  const close = vi.fn(),
    mount = vi.fn()
  mocks.sdk.mockResolvedValue({
    close,
    authorization: { snapshot: () => ({ policy: { modules: [] } }) },
    tradingTerminal: { mount },
  })
  const props = options()
  const workstation = createWorkstation(props)
  await workstation.started
  expect(props.setLoadState).toHaveBeenCalledWith({
    state: 'error',
    message: 'SDK access does not include the workstation chart. Restore SDK access and retry.',
  })
  expect(props.setLoadState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'ready' }))
  expect(mount).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

it('waits for broker initialization and never publishes ready when reading state fails', async () => {
  const controller = new AbortController(),
    ready = vi.fn()
  const trading = {
    connect: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockRejectedValue(new Error('Provider unavailable')),
  }
  await expect(initializeWorkstationTrading(trading, controller.signal, ready)).rejects.toThrow(
    'Provider unavailable',
  )
  expect(trading.connect).toHaveBeenCalledOnce()
  expect(ready).not.toHaveBeenCalled()
})

it('ignores broker initialization finishing after attempt disposal', async () => {
  const controller = new AbortController(),
    ready = vi.fn()
  const connected = Promise.withResolvers<void>()
  const trading = { connect: vi.fn(() => connected.promise), getState: vi.fn() }
  const initialized = initializeWorkstationTrading(trading, controller.signal, ready)
  controller.abort()
  connected.resolve()
  await initialized
  expect(trading.getState).not.toHaveBeenCalled()
  expect(ready).not.toHaveBeenCalled()
})

it('publishes ready only after the initial broker state is available', async () => {
  const controller = new AbortController()
  const ready = vi.fn()
  const state = Promise.withResolvers<{
    connectionStatus: 'connected'
    accounts: []
    orders: []
    positions: []
    executions: []
  }>()
  const trading = {
    connect: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(() => state.promise),
  }
  const initialized = initializeWorkstationTrading(trading, controller.signal, ready)
  await vi.waitFor(() => expect(trading.getState).toHaveBeenCalledOnce())
  expect(ready).not.toHaveBeenCalled()
  state.resolve({
    connectionStatus: 'connected',
    accounts: [],
    orders: [],
    positions: [],
    executions: [],
  })
  await initialized
  expect(ready).toHaveBeenCalledOnce()
})

it.each([
  { riskState: 'disabled', enabled: false },
  { riskState: 'unavailable', enabled: true },
  { riskState: 'ready', enabled: true },
] as const)(
  'keeps the workstation usable with agent risk $riskState and releases its resources',
  async ({ riskState, enabled }) => {
    const riskAuthority = { controller: {}, requests: {}, destroy: vi.fn() }
    const pending = Promise.withResolvers<typeof riskAuthority>()
    const fixture = mountedWorkstation(pending.promise, enabled)
    const { props, mount, update, destroy, close, workstation } = fixture
    try {
      await workstation.started
      if (riskState === 'unavailable')
        pending.reject(new Error('A fresh account currency conversion is unavailable.'))
      else pending.resolve(riskAuthority)
      await vi.waitFor(() =>
        expect(props.setLoadState).toHaveBeenLastCalledWith(
          expect.objectContaining({
            state: 'ready',
            agentRisk: expect.objectContaining({ state: riskState }),
          }),
        ),
      )
      expect(mount).toHaveBeenCalledOnce()
      expect(
        props.setLoadState.mock.calls
          .map(([state]) => state)
          .filter((state) => state.state === 'loading')
          .map((state) => state.progress.stage),
      ).toEqual(['sdk', 'watchlist', 'instrument', 'workspace', 'account'])
      expect(mount.mock.calls[0]?.[0].agentic).toEqual({
        read: enabled,
        write: enabled,
        trade: false,
      })
      expect(mocks.adapter.mock.calls[0]?.[0]).not.toHaveProperty('risk')
      expect(mocks.adapter.mock.calls[0]?.[0]).not.toHaveProperty('riskRequests')
      if (riskState === 'ready') {
        expect(mocks.adapter).toHaveBeenCalledTimes(2)
        expect(mocks.adapter.mock.calls[1]?.[0]).toMatchObject({
          risk: riskAuthority.controller,
          riskRequests: riskAuthority.requests,
          agenticAccess: { read: true, write: true, trade: { mode: 'paper' } },
        })
      } else expect(mocks.adapter).toHaveBeenCalledOnce()
      expect(props.setLoadState).not.toHaveBeenCalledWith(
        expect.objectContaining({ state: 'error' }),
      )
      expect(mount.mock.calls[0]?.[0].theme).toMatchObject({ base: 'dark' })
      expect(mount.mock.calls[0]?.[0].accountPanelOptions).toMatchObject({
        defaultPageId: 'positions',
        theme: { base: 'dark' },
      })
      update.mockClear()
      props.appearance.set('light')
      props.appearance.set('dark')
      expect(update).toHaveBeenCalledTimes(2)
      expect(update).toHaveBeenNthCalledWith(1, {
        theme: expect.objectContaining({ base: 'light' }),
        accountPanelOptions: expect.objectContaining({
          defaultPageId: 'positions',
          theme: expect.objectContaining({ base: 'light' }),
        }),
      })
      expect(update).toHaveBeenNthCalledWith(2, {
        theme: expect.objectContaining({ base: 'dark' }),
        accountPanelOptions: expect.objectContaining({
          defaultPageId: 'positions',
          theme: expect.objectContaining({ base: 'dark' }),
        }),
      })
      expect(mount).toHaveBeenCalledOnce()
      expect(mocks.sdk).toHaveBeenCalledOnce()
      const adapters = mocks.adapter.mock.results.map(({ value }) => value)
      for (const adapter of adapters) {
        expect(adapter.trading.connect).toHaveBeenCalledOnce()
        expect(adapter.trading.disconnect).not.toHaveBeenCalled()
      }
      expect(destroy).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
      expect(adapters[0].destroy).not.toHaveBeenCalled()
      expect(props.setActiveInstrument).toHaveBeenLastCalledWith(fixture.symbol)
      await workstation.dispose()
      expect(destroy).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
      for (const adapter of adapters) expect(adapter.destroy).toHaveBeenCalledOnce()
      const mountDestroyedAt = destroy.mock.invocationCallOrder[0]
      if (mountDestroyedAt === undefined)
        throw new Error('The mounted workspace was not destroyed.')
      for (const adapter of adapters)
        expect(adapter.destroy.mock.invocationCallOrder[0]).toBeGreaterThan(mountDestroyedAt)
      expect(adapters.at(-1).trading.disconnect).toHaveBeenCalledOnce()
      for (const bridge of mocks.mcp.mock.results)
        expect(bridge.value.dispose).toHaveBeenCalledOnce()
      expect(fixture.stopQuotes).toHaveBeenCalledOnce()
      expect(fixture.stopDepth).toHaveBeenCalledOnce()
      expect(fixture.marketData.destroy).toHaveBeenCalledOnce()
      expect(fixture.symbolLink.destroy).toHaveBeenCalledOnce()
      expect(riskAuthority.destroy).toHaveBeenCalledTimes(riskState === 'ready' ? 1 : 0)
      const updatesAtDisposal = update.mock.calls.length
      props.appearance.set('light')
      expect(update).toHaveBeenCalledTimes(updatesAtDisposal)
      expect(mount).toHaveBeenCalledOnce()
    } finally {
      await workstation.dispose()
    }
  },
)

it('keeps agent orders blocked when the verified controller cannot initialize', async () => {
  const authority = { controller: {}, requests: {}, destroy: vi.fn() }
  const pending = Promise.withResolvers<typeof authority>()
  const fixture = mountedWorkstation(pending.promise)
  const original = mocks.adapter.getMockImplementation()
  if (!original) throw new Error('Missing fixture adapter factory.')
  mocks.adapter.mockImplementation((configuration) => {
    const adapter = original(configuration)
    if (configuration.risk)
      adapter.trading.getState.mockRejectedValue(new Error('Broker state unavailable.'))
    return adapter
  })
  try {
    await fixture.workstation.started
    await vi.waitFor(() => expect(mocks.risk).toHaveBeenCalledOnce())
    pending.resolve(authority)
    await vi.waitFor(() =>
      expect(fixture.props.setLoadState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: 'ready',
          agentRisk: { state: 'unavailable', message: 'Broker state unavailable.' },
        }),
      ),
    )
    expect(fixture.mount).toHaveBeenCalledOnce()
    expect(fixture.update.mock.calls.some(([next]) => next.adapter !== undefined)).toBe(false)
    expect(mocks.mcp).toHaveBeenCalledOnce()
    expect(mocks.mcp.mock.calls[0]?.[0].agentic.getAccessPolicy().trade).toBe(false)
    expect(mocks.adapter.mock.results[0]?.value.destroy).not.toHaveBeenCalled()
    expect(mocks.adapter.mock.results[1]?.value.destroy).toHaveBeenCalledOnce()
    expect(authority.destroy).toHaveBeenCalledOnce()
    expect(fixture.props.setLoadState).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'error' }),
    )
  } finally {
    await fixture.workstation.dispose()
  }
  expect(authority.destroy).toHaveBeenCalledOnce()
})

it('cancels a prepared agent controller before it can replace the mounted workspace', async () => {
  const authority = { controller: {}, requests: {}, destroy: vi.fn() }
  const pendingRisk = Promise.withResolvers<typeof authority>()
  const pendingConnection = Promise.withResolvers<void>()
  const fixture = mountedWorkstation(pendingRisk.promise)
  const original = mocks.adapter.getMockImplementation()
  if (!original) throw new Error('Missing fixture adapter factory.')
  mocks.adapter.mockImplementation((configuration) => {
    const adapter = original(configuration)
    if (configuration.risk) adapter.trading.connect.mockReturnValue(pendingConnection.promise)
    return adapter
  })
  await fixture.workstation.started
  await vi.waitFor(() => expect(mocks.risk).toHaveBeenCalledOnce())
  pendingRisk.resolve(authority)
  await vi.waitFor(() => expect(mocks.adapter).toHaveBeenCalledTimes(2))
  await fixture.workstation.dispose()
  const updates = fixture.update.mock.calls.length
  const publications = fixture.props.setLoadState.mock.calls.length
  pendingConnection.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(fixture.update).toHaveBeenCalledTimes(updates)
  expect(fixture.props.setLoadState).toHaveBeenCalledTimes(publications)
  expect(mocks.mcp.mock.results[0]?.value.replaceAgentic).not.toHaveBeenCalled()
  expect(mocks.adapter.mock.results[1]?.value.trading.getState).not.toHaveBeenCalled()
  for (const adapter of mocks.adapter.mock.results)
    expect(adapter.value.destroy).toHaveBeenCalledOnce()
  expect(authority.destroy).toHaveBeenCalledOnce()
})
