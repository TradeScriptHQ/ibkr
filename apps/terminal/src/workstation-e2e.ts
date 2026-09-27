import type { SdkSymbolInfo, TradingTerminalApi } from '@tradescript/pro/sdk'
import type { createConnectionRiskAuthority } from './risk.js'

interface ChartTradingE2EDriver {
  getPaperTradingController(): Promise<NonNullable<TradingTerminalApi['trading']>>
  getOrderDraftMessage(): { readonly type: 'info' | 'error'; readonly text: string } | undefined
  openOrderDraft(price: number): Promise<void>
  openOversizedOrderDraft(price: number): Promise<void>
  previewMissingOrder(price: number): Promise<{ readonly error?: string }>
  submitOrderDraft(): Promise<unknown>
}

declare global {
  interface Window {
    __ibkrChartTradingE2E__?: ChartTradingE2EDriver
  }
}

export function installWorkstationE2e(
  trading: NonNullable<TradingTerminalApi['trading']>,
  symbol: SdkSymbolInfo,
  risk: Awaited<ReturnType<typeof createConnectionRiskAuthority>> | undefined,
): void {
  if (import.meta.env.DEV) {
    window.__ibkrChartTradingE2E__ = {
      async getPaperTradingController() {
        if (trading.getExecutionEnvironment() !== 'paper') throw new Error('Paper TWS is required')
        const state = await trading.getState()
        if (state.connectionStatus !== 'connected' || !state.activeAccountId?.startsWith('DU')) {
          throw new Error('A connected paper account is required')
        }
        return trading
      },
      getOrderDraftMessage() {
        return trading.getOrderDraft()?.draft.message
      },
      async openOrderDraft(price) {
        const state = await trading.getState()
        trading.openOrderDraft(
          {
            side: null,
            entryType: 'limit',
            quantity: 1,
            entryPrice: price,
            exitLevels: [],
            activeLine: { kind: 'entry' },
          },
          {
            symbol,
            ...(state.activeAccountId ? { accountId: state.activeAccountId } : {}),
            ...(symbol.currency ? { currency: symbol.currency } : {}),
            lastPrice: price,
          },
        )
      },
      async openOversizedOrderDraft(price) {
        const state = await trading.getState()
        trading.openOrderDraft(
          {
            side: 'buy',
            entryType: 'limit',
            quantity: 1_000_000,
            entryPrice: price,
            exitLevels: [],
            activeLine: { kind: 'entry' },
          },
          {
            symbol,
            ...(state.activeAccountId ? { accountId: state.activeAccountId } : {}),
            ...(symbol.currency ? { currency: symbol.currency } : {}),
            lastPrice: price,
          },
        )
      },
      async previewMissingOrder(price) {
        const state = await trading.getState()
        try {
          await trading.previewModifyOrder(
            '__e2e_missing_order__',
            { price },
            {
              symbol,
              ...(state.activeAccountId ? { accountId: state.activeAccountId } : {}),
              ...(symbol.currency ? { currency: symbol.currency } : {}),
              lastPrice: price,
            },
          )
          return {}
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      async submitOrderDraft() {
        try {
          return { result: await trading.submitOrderDraft() }
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            ...(risk === undefined
              ? {}
              : { riskDecision: risk.controller.getDecisionReceipts({ limit: 1 })[0] }),
          }
        }
      },
    }
  }
}
export function removeWorkstationE2e(): void {
  delete window.__ibkrChartTradingE2E__
}
