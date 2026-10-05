import type { SystemStatusResponse } from '@ibkr-terminal/contracts'
import {
  type AgenticAccessPolicy,
  createTradeScriptAdapter,
  type SdkSymbolInfo,
  type TradeScriptAdapterApi,
  type TradingControllerApi,
  type TradingTerminalApi,
} from '@tradescript/pro/sdk'
import type { PanelLayoutControllerApi } from '@tradescript/pro/sdk/trading'
import type { AppearanceStore } from './appearance.js'
import { APP_NAME } from './branding.js'
import { followDepthLadderPrice } from './ibkr/depth-ladder-price.js'
import { createDepthRowExtension } from './ibkr/depth-row-extension.js'
import { depthStatusMessage, followDepthStatus } from './ibkr/depth-status.js'
import { createIbkrHttpBrokerAdapter } from './ibkr/http-broker-adapter.js'
import { createIbkrMarketDatafeed } from './ibkr/market-datafeed.js'
import { followOptionTicketRejections } from './ibkr/option-ticket-rejection.js'
import { loadForecastOutcomes } from './ibkr/prediction-ticket.js'
import { followInstrument, readInstrument } from './instrument-preference.js'
import { createMcpAgentConsoleController } from './mcp/agent-console.js'
import { connectTradeScriptMcp } from './mcp/browser-bridge.js'
import { createLocalSimulation, MOCK_ACCOUNT_ID } from './mock/local-simulation.js'
import type { ConnectionRiskAuthority } from './risk.js'
import { followSdkLease } from './sdk-lease-renewal.js'
import { createTerminalTradeScriptSdk } from './terminal-session.js'
import { createLocalWatchlistAdapter } from './watchlist.js'
import { activateWorkstationWidget, arrangeDesktopWorkstation } from './workspace-layout.js'
import {
  type AgentRiskAvailability,
  initializeWorkstationAgentRisk,
} from './workstation-agent-risk.js'
import { authorizeWorkstation } from './workstation-authorization.js'
import { installWorkstationE2e, removeWorkstationE2e } from './workstation-e2e.js'
import { WorkstationLifetime } from './workstation-lifetime.js'
import { type WorkstationLoadingState, workstationLoading } from './workstation-startup.js'
import { WORKSTATION_ACCOUNT_THEMES, WORKSTATION_THEMES } from './workstation-theme.js'
import {
  licensedWorkstationSessionMeta,
  licensedWorkstationWidgets,
  WORKSTATION_MESSAGE_AUTO_DISMISS_MS,
} from './workstation-widgets.js'

export type LoadState =
  | WorkstationLoadingState
  | { readonly state: 'error'; readonly message: string }
  | {
      readonly state: 'ready'
      readonly status: SystemStatusResponse
      readonly agentRisk: AgentRiskAvailability
    }

export interface ChartDataRow {
  readonly time: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume?: number
}

export interface ChartDataSnapshot {
  readonly bars: ChartDataRow[]
  readonly interval: string
  readonly symbol?: SdkSymbolInfo
  readonly formatPrice?: (price: number) => string
}

export interface WorkstationOptions {
  readonly appearance: AppearanceStore
  readonly host: HTMLDivElement | null
  readonly sessionMetaHost: HTMLDivElement | null
  readonly setChartBarsReader: (reader: () => ChartDataSnapshot) => void
  readonly setActiveInstrument: (symbol: SdkSymbolInfo) => void
  readonly setLoadState: (state: LoadState) => void
  readonly mockMode: boolean
}

export async function initializeWorkstationTrading(
  trading: Pick<TradingControllerApi, 'connect' | 'getState'>,
  signal: AbortSignal,
  onReady: () => void,
): Promise<void> {
  await trading.connect()
  if (signal.aborted) return
  await trading.getState()
  if (!signal.aborted) onReady()
}

/** Owns one startup attempt and its resources independently of React's component lifetime. */
export function createWorkstation({
  appearance,
  host,
  sessionMetaHost,
  setChartBarsReader,
  setActiveInstrument,
  setLoadState,
  mockMode,
}: WorkstationOptions) {
  const lifetime = new WorkstationLifetime()
  let terminal: TradingTerminalApi | undefined
  let terminalInitialization: Promise<void> | undefined
  let layoutController: PanelLayoutControllerApi | undefined
  let destroyLayoutSizing: (() => void) | undefined
  const controller = lifetime.controller
  lifetime.defer(() => {
    removeWorkstationE2e()
    setChartBarsReader(() => ({ bars: [], interval: '5m' }))
    destroyLayoutSizing?.()
  })

  const start = async () => {
    if (host === null) throw new Error('The terminal mount is unavailable.')

    const { session, status, bootstrap, connection } = await authorizeWorkstation(
      controller.signal,
      mockMode,
      setLoadState,
    )
    if (lifetime.disposed) return
    const executionEnvironment = mockMode ? 'paper' : status.environment
    document.title = mockMode
      ? `${APP_NAME} · Simulation`
      : `${APP_NAME} · ${executionEnvironment === 'live' ? 'Live' : 'Paper'}`
    setLoadState(workstationLoading('sdk'))
    const sdk = await createTerminalTradeScriptSdk(bootstrap.lease)
    lifetime.defer(() => sdk.close())
    if (lifetime.disposed) {
      return
    }
    const widgets = licensedWorkstationWidgets(sdk.authorization?.snapshot().policy)
    if (sdk.authorization)
      lifetime.defer(
        followSdkLease(sdk.authorization, bootstrap, controller.signal, (message) => {
          if (lifetime.disposed) return
          setLoadState({ state: 'error', message })
          void lifetime.dispose()
        }),
      )

    const simulation = mockMode
      ? createLocalSimulation({
          createDefaultAccountManagerInfo: () =>
            sdk.trading.createDefaultTradingAccountManagerInfo({ supportsBatchCancel: true }),
        })
      : undefined
    const datafeed =
      simulation?.datafeed ?? createIbkrMarketDatafeed({ baseUrl: '/api/v1/ibkr', pollMs: 2_500 })
    const broker =
      simulation?.broker ??
      createIbkrHttpBrokerAdapter({
        baseUrl: '/api/v1/ibkr',
        providerName: 'IBKR',
        executionEnvironment: status.environment,
        csrfToken: session.csrfToken,
        ...(connection ? { connectionGeneration: connection.generation } : {}),
        createDefaultAccountManagerInfo: () =>
          sdk.trading.createDefaultTradingAccountManagerInfo({
            supportsBatchCancel: true,
            supportsAccountPnl: true,
          }),
      })
    const profile = connection?.settings.profiles[connection.settings.active]
    const connectionAgentPolicy = profile
      ? {
          enabled: profile.agentTradingEnabled,
          autonomyMode: bootstrap.paperTrading.autonomyMode,
          allowedAccountIds: profile.allowedAccountIds,
          limits: profile.limits,
        }
      : undefined
    const riskConfig = mockMode
      ? {
          enabled: true,
          autonomyMode: 'paper-auto' as const,
          allowedAccountIds: [MOCK_ACCOUNT_ID],
          limits: {
            maxOrderQuantity: 10_000,
            maxOrderNotional: 500_000,
            maxPositionQuantity: 20_000,
            maxPositionNotional: 1_000_000,
            maxGrossExposure: 2_000_000,
            maxDailyLoss: 25_000,
            maxOrdersPerMinute: 120,
            maxEstimatedSlippageBps: 100,
            maxMarketDataAgeMs: 30_000,
            maxLeverage: 4,
            maxUnprotectedPositionQuantity: 20_000,
          },
        }
      : connectionAgentPolicy
    if (!riskConfig) throw new Error('The broker connection settings are unavailable.')
    let risk: ConnectionRiskAuthority | undefined
    let agentRisk: AgentRiskAvailability = { state: riskConfig.enabled ? 'checking' : 'disabled' }
    const marketData = sdk.marketData.createController(datafeed)
    lifetime.defer(() => marketData.destroy())
    const symbolLink = sdk.symbols.createLinkController({ groupId: 'tradescript-default' })
    lifetime.defer(() => symbolLink.destroy())
    // Both compositions share data/instrument controllers and remain owned until the mount is destroyed.
    // Lazy chart surfaces can still hold the initial composition during the adapter handoff.
    const adapters = new Set<TradeScriptAdapterApi>()
    lifetime.defer(() => {
      for (const owned of adapters) owned.destroy()
      adapters.clear()
      risk?.destroy()
    })
    const agenticAccess: AgenticAccessPolicy = {
      read: riskConfig.enabled,
      write: riskConfig.enabled,
      trade: false,
    }
    let adapter = createTradeScriptAdapter({
      marketData: { feed: datafeed, controller: marketData },
      symbolLink,
      trading: { broker },
      agenticAccess,
    })
    let pendingAgentAdapter: TradeScriptAdapterApi | undefined
    adapters.add(adapter)
    const agentConsole = createMcpAgentConsoleController(executionEnvironment, agentRisk)
    lifetime.defer(() => agentConsole.destroy())
    const publishAgentRisk = (next: AgentRiskAvailability) => {
      if (lifetime.disposed) return
      agentRisk = next
      agentConsole.publishAgentRisk(next)
      setLoadState({ state: 'ready', status, agentRisk })
    }
    let mcp: ReturnType<typeof connectTradeScriptMcp> | undefined
    const initializeAgentTrading = async () => {
      const initializedRisk = await initializeWorkstationAgentRisk(
        sdk,
        broker,
        datafeed,
        riskConfig,
        executionEnvironment,
      )
      if (lifetime.disposed) {
        if (initializedRisk.state === 'ready') initializedRisk.authority.destroy()
        return
      }
      if (initializedRisk.state !== 'ready') {
        publishAgentRisk(initializedRisk)
        return
      }
      risk = initializedRisk.authority
      const verifiedAccess: AgenticAccessPolicy = {
        read: true,
        write: true,
        trade: { mode: executionEnvironment },
      }
      let verifiedAdapter: TradeScriptAdapterApi | undefined
      try {
        verifiedAdapter = createTradeScriptAdapter({
          marketData: { feed: datafeed, controller: marketData },
          symbolLink,
          trading: { broker },
          risk: risk.controller,
          riskRequests: risk.requests,
          agenticAccess: verifiedAccess,
        })
        adapters.add(verifiedAdapter)
        const trading = verifiedAdapter.trading
        if (!trading) throw new Error('The agent trading controller is unavailable.')
        const verified = verifiedAdapter
        await initializeWorkstationTrading(trading, controller.signal, () => {
          pendingAgentAdapter = verified
          mounted.update({ adapter: verified, agentic: verifiedAccess })
        })
      } catch (error: unknown) {
        if (!lifetime.disposed && adapter !== verifiedAdapter) {
          pendingAgentAdapter = undefined
          if (verifiedAdapter) {
            verifiedAdapter.destroy()
            adapters.delete(verifiedAdapter)
          }
          risk.destroy()
          risk = undefined
        }
        throw error
      }
    }
    setLoadState(workstationLoading('watchlist'))
    const watchlist = await createLocalWatchlistAdapter(datafeed, () =>
      adapter.symbolLink.getSymbol(),
    )
    setLoadState(workstationLoading('instrument'))
    const symbol =
      readInstrument(localStorage) ??
      (datafeed.resolveSymbol
        ? await datafeed.resolveSymbol('AAPL')
        : {
            ticker: 'AAPL',
            canonicalSymbol: 'ibkr:AAPL',
            brokerSymbol: 'AAPL',
            exchange: 'SMART',
            listedExchange: 'NASDAQ',
            currency: 'USD',
            type: 'stock' as const,
          })
    if (lifetime.disposed) return

    let stopOptionTicketRejections: (() => void) | undefined
    const depthRows = createDepthRowExtension()
    setLoadState(workstationLoading('workspace'))
    const initialAppearance = appearance.getSnapshot()
    const sessionMetaOptions = licensedWorkstationSessionMeta(sdk.authorization?.snapshot().policy)
    const sessionMeta =
      sessionMetaHost && sessionMetaOptions
        ? sdk.sessionMeta.mount({
            ...sessionMetaOptions,
            mount: sessionMetaHost,
            controller: marketData,
            symbol,
            theme: WORKSTATION_THEMES[initialAppearance],
          })
        : undefined
    if (sessionMeta) lifetime.defer(() => sessionMeta.destroy())
    const mounted = sdk.tradingTerminal.mount({
      ...widgets,
      theme: WORKSTATION_THEMES[initialAppearance],
      accountPanelOptions: {
        ...widgets.accountPanelOptions,
        theme: WORKSTATION_ACCOUNT_THEMES[initialAppearance],
      },
      predictionMarketOutcomes: loadForecastOutcomes,
      mount: host,
      adapter,
      symbol,

      terminalId: mockMode ? 'local-mock-workstation' : `ibkr-${status.environment}-workstation`,

      agentic: agenticAccess,
      watchlistAdapter: watchlist,

      agentConsoleOptions: { controller: agentConsole },

      optionTicketOptions: {
        messageAutoDismissMs: WORKSTATION_MESSAGE_AUTO_DISMISS_MS,
        onReady(controller) {
          stopOptionTicketRejections?.()
          stopOptionTicketRejections = followOptionTicketRejections(broker, controller)
        },
      },

      optionChainOptions: {
        ...widgets.optionChainOptions,
        onContractSelect() {
          activateWorkstationWidget(layoutController, 'option-ticket')
        },
      },

      depthLadderOptions: {
        priceWindow: 'follow-price',
        slotStyles: { waitingState: { whiteSpace: 'pre-line' } },
        labels: {
          waitingForData: mockMode ? 'Waiting for market depth.' : depthStatusMessage(symbol),
        },
      },
      marketDepthOptions: {
        frameless: true,
        levelExtension: depthRows.extension,
        style: { whiteSpace: 'pre-line' },
        levels: 20,
        labels: {
          emptyStateWaitingData: mockMode
            ? 'Waiting for market depth.'
            : depthStatusMessage(symbol),
        },
      },

      onReady(widget) {
        if (lifetime.disposed) return
        setChartBarsReader(() => ({
          interval: widget.chart().getInterval(),
          symbol: widget.chart().getSymbol(),
          formatPrice: (price) => widget.chart().priceFormatter().format(price),
          bars: widget
            .chart()
            .getLoadedBars()
            .map((bar) => ({
              time: bar.time,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              ...(bar.volume === undefined ? {} : { volume: bar.volume }),
            })),
        }))
      },

      onLayoutReady(layout) {
        layoutController = layout
        requestAnimationFrame(() => {
          if (lifetime.disposed) return
          destroyLayoutSizing?.()
          destroyLayoutSizing = arrangeDesktopWorkstation(layout, host)
        })
      },
      onTerminalReady(api) {
        if (lifetime.disposed) return
        if (api.adapter !== adapter && api.adapter !== pendingAgentAdapter) return
        if (terminalInitialization && api.adapter !== pendingAgentAdapter) return
        const trading = api.trading
        if (trading === undefined) {
          if (!lifetime.disposed) {
            setLoadState({
              state: 'error',
              message: `${APP_NAME} did not provide its trading controller.`,
            })
          }
          return
        }
        host.dataset.tradingOperationSupport = JSON.stringify(
          Object.keys(trading.getOperationSupport()).sort(),
        )
        installWorkstationE2e(trading, symbol, risk)
        terminal = api
        if (terminalInitialization) {
          adapter = api.adapter
          pendingAgentAdapter = undefined
          mcp?.replaceAgentic(adapter.agentic)
          publishAgentRisk({ state: 'ready' })
          return
        }
        setLoadState(workstationLoading('account'))
        terminalInitialization = initializeWorkstationTrading(trading, controller.signal, () => {
          setLoadState({ state: 'ready', status, agentRisk })
          if (riskConfig.enabled)
            void initializeAgentTrading().catch((error: unknown) => {
              publishAgentRisk({
                state: 'unavailable',
                message:
                  error instanceof Error
                    ? error.message
                    : 'The broker risk checks could not be completed.',
              })
            })
        }).catch((error: unknown) => {
          if (!lifetime.disposed) {
            setLoadState({
              state: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : 'The IBKR trading controller could not connect.',
            })
            void lifetime.dispose()
          }
        })
      },
    })
    lifetime.defer(() => mounted.destroy())
    lifetime.defer(
      appearance.subscribe(() => {
        if (lifetime.disposed) return
        const mode = appearance.getSnapshot()
        sessionMeta?.update({ theme: WORKSTATION_THEMES[mode] })
        mounted.update({
          theme: WORKSTATION_THEMES[mode],
          accountPanelOptions: {
            ...widgets.accountPanelOptions,
            theme: WORKSTATION_ACCOUNT_THEMES[mode],
          },
        })
      }),
    )
    lifetime.defer(() => stopOptionTicketRejections?.())
    const stopInstrument = followInstrument(
      adapter.symbolLink,
      symbol,
      localStorage,
      (nextSymbol) => {
        setActiveInstrument(nextSymbol)
        sessionMeta?.update({ symbol: nextSymbol })
      },
    )
    lifetime.defer(stopInstrument)
    let ladderPrice: number | undefined
    let depthMessage = mockMode ? 'Waiting for market depth.' : depthStatusMessage(symbol)
    const updateDepthPresentation = () => {
      mounted.update({
        marketDepthOptions: {
          frameless: true,
          levelExtension: depthRows.extension,
          levels: 20,
          style: { whiteSpace: 'pre-line' },
          labels: { emptyStateWaitingData: depthMessage },
        },
        depthLadderOptions: {
          ...(ladderPrice === undefined ? {} : { currentPrice: ladderPrice }),
          priceWindow: 'follow-price',
          slotStyles: { waitingState: { whiteSpace: 'pre-line' } },
          labels: { waitingForData: depthMessage },
        },
      })
    }
    const stopDepthStatus = mockMode
      ? undefined
      : followDepthStatus(adapter, symbol, (message) => {
          depthRows.setMessage(message)
          depthMessage = message
          updateDepthPresentation()
        })
    if (stopDepthStatus) lifetime.defer(stopDepthStatus)
    const stopDepthLadderPrice = followDepthLadderPrice(adapter, symbol, (price) => {
      ladderPrice = price
      updateDepthPresentation()
    })
    lifetime.defer(stopDepthLadderPrice)
    lifetime.defer(async () => {
      await terminal?.trading?.disconnect()
    })
    mcp = connectTradeScriptMcp({
      agentic: adapter.agentic,
      onState: (state) => agentConsole.publishMcp(state),
    })
    lifetime.defer(() => mcp?.dispose())
  }

  const started = start().catch((error: unknown) => {
    if (!lifetime.disposed) {
      setLoadState({
        state: 'error',
        message: error instanceof Error ? error.message : 'The workstation could not start.',
      })
    }
    return lifetime.dispose()
  })

  return { started, dispose: () => lifetime.dispose() }
}
