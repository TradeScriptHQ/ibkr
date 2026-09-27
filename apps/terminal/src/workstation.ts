import type { SystemStatusResponse } from '@ibkr-terminal/contracts'
import {
  createTradeScriptAdapter,
  type SdkSymbolInfo,
  type TradingTerminalApi,
} from '@tradescript/pro/sdk'
import type { PanelLayoutControllerApi } from '@tradescript/pro/sdk/trading'
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
import { createConnectionRiskAuthority } from './risk.js'
import { createTerminalTradeScriptSdk } from './terminal-session.js'
import { createLocalWatchlistAdapter } from './watchlist.js'
import { activateWorkstationWidget, arrangeDesktopWorkstation } from './workspace-layout.js'
import { authorizeWorkstation } from './workstation-authorization.js'
import { installWorkstationE2e, removeWorkstationE2e } from './workstation-e2e.js'
import { WorkstationLifetime } from './workstation-lifetime.js'
import {
  applyChartAppearance,
  WORKSTATION_MESSAGE_AUTO_DISMISS_MS,
  WORKSTATION_WIDGETS,
} from './workstation-widgets.js'

export type LoadState =
  | { readonly state: 'loading'; readonly message: string }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'ready'; readonly status: SystemStatusResponse }

export interface ChartDataRow {
  readonly time: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume?: number
}

export interface WorkstationOptions {
  readonly host: HTMLDivElement | null
  readonly setChartBarsReader: (reader: () => ChartDataRow[]) => void
  readonly setActiveInstrument: (symbol: SdkSymbolInfo) => void
  readonly setLoadState: (state: LoadState) => void
  readonly mockMode: boolean
}

/** Owns one startup attempt and its resources independently of React's component lifetime. */
export function createWorkstation({
  host,
  setChartBarsReader,
  setActiveInstrument,
  setLoadState,
  mockMode,
}: WorkstationOptions) {
  const lifetime = new WorkstationLifetime()
  let terminal: TradingTerminalApi | undefined
  let layoutController: PanelLayoutControllerApi | undefined
  let destroyLayoutSizing: (() => void) | undefined
  const controller = lifetime.controller
  lifetime.defer(() => {
    removeWorkstationE2e()
    setChartBarsReader(() => [])
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
    document.title = `TradeScript · IBKR ${status.environment === 'live' ? 'Live' : 'Paper'} Terminal`
    setLoadState({ state: 'loading', message: 'Loading the TradeScript trading surfaces…' })
    const sdk = await createTerminalTradeScriptSdk(bootstrap.lease)
    lifetime.defer(() => sdk.close())
    if (lifetime.disposed) {
      return
    }

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
      : bootstrap.paperTrading
    const risk = riskConfig.enabled
      ? await createConnectionRiskAuthority(sdk, broker, datafeed, riskConfig, status.environment)
      : undefined
    if (risk) lifetime.defer(() => risk.destroy())
    if (lifetime.disposed) return
    const adapter = createTradeScriptAdapter({
      marketData: { feed: datafeed },
      trading: { broker },
      ...(risk === undefined ? {} : { risk: risk.controller, riskRequests: risk.requests }),
      ...(riskConfig.enabled ? { agenticAccess: true as const } : {}),
    })
    lifetime.defer(() => adapter.destroy())
    const agentConsole = createMcpAgentConsoleController(status.environment, riskConfig.enabled)
    lifetime.defer(() => agentConsole.destroy())
    const watchlist = createLocalWatchlistAdapter()
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
    const mounted = sdk.tradingTerminal.mount({
      ...WORKSTATION_WIDGETS,
      predictionMarketOutcomes: loadForecastOutcomes,
      mount: host,
      adapter,
      symbol,

      terminalId: mockMode ? 'local-mock-workstation' : 'ibkr-paper-workstation',

      agentic: true,
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
        ...WORKSTATION_WIDGETS.optionChainOptions,
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
        setChartBarsReader(() =>
          widget
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
        )
        applyChartAppearance(widget)
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
        const trading = api.trading
        if (trading === undefined) {
          if (!lifetime.disposed) {
            setLoadState({
              state: 'error',
              message: 'The TradeScript terminal did not provide its trading controller.',
            })
          }
          return
        }
        host.dataset.tradingOperationSupport = JSON.stringify(
          Object.keys(trading.getOperationSupport()).sort(),
        )
        installWorkstationE2e(trading, symbol, risk)
        terminal = api
        if (!lifetime.disposed) setLoadState({ state: 'ready', status })
        void (async () => {
          await trading.connect()
          await trading.getState()
        })().catch((error: unknown) => {
          if (!lifetime.disposed) {
            setLoadState({
              state: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : 'The IBKR trading controller could not connect.',
            })
          }
        })
      },
    })
    lifetime.defer(() => mounted.destroy())
    lifetime.defer(() => stopOptionTicketRejections?.())
    const stopInstrument = followInstrument(
      adapter.symbolLink,
      symbol,
      localStorage,
      setActiveInstrument,
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
    lifetime.defer(
      connectTradeScriptMcp({
        agentic: adapter.agentic,
        onState: (state) => agentConsole.publishMcp(state),
      }),
    )
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
