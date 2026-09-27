import type { Contract } from '@stoqey/ib'
import { EventName, type IBApi } from '@stoqey/ib'
import { finiteNumber } from './numbers.js'
import { optionContractWithSourceIdentity } from './option-chain.js'
import { fromIbPosition } from './orders.js'
import type { BrokerStateStore } from './state-store.js'
import type { AccountSummary, BrokerSymbol } from './types.js'

const ACCOUNT_PNL_REQUEST_ID = 9103
/** Owns account summaries, portfolio/PnL subscriptions and account event decoding. */
export class AccountSubscriptions {
  constructor(
    private readonly ib: IBApi,
    private readonly store: BrokerStateStore,
    private readonly symbolFromContract: (
      contract: Contract,
      preferred?: BrokerSymbol,
    ) => BrokerSymbol,
  ) {
    this.registerHandlers()
  }
  clear(): void {
    this.subscribedPortfolioAccountId = undefined
    this.subscribedPnlAccountId = undefined
  }
  private registerHandlers(): void {
    this.ib.on(EventName.managedAccounts, (accountsList: string) => {
      const accountIds = accountsList
        .split(',')
        .map((account) => account.trim())
        .filter(Boolean)
      for (const accountId of accountIds) {
        this.accountSummaries.set(accountId, {
          id: accountId,
          label: accountId,
          currency: 'USD',
          ...this.accountSummaries.get(accountId),
        })
      }
      this.flushAccounts()
    })
    this.ib.on(
      EventName.accountSummary,
      (_reqId: number, account: string, tag: string, value: string, currency: string) => {
        const summary = this.accountSummaries.get(account) ?? {
          id: account,
          label: account,
          currency: currency || 'USD',
        }
        const numeric = Number(value)
        const parsed = Number.isFinite(numeric) ? numeric : undefined
        if (tag === 'NetLiquidation') summary.netLiquidation = parsed
        if (tag === 'AvailableFunds') summary.availableFunds = parsed
        if (tag === 'BuyingPower') summary.buyingPower = parsed
        if (tag === 'TotalCashValue') summary.cash = parsed
        if (tag === 'InitMarginReq') summary.marginUsed = parsed
        if (tag === 'MaintMarginReq') summary.maintenanceMargin = parsed
        summary.currency = currency || summary.currency || 'USD'
        this.accountSummaries.set(account, summary)
        this.flushAccounts()
      },
    )
    this.ib.on(
      EventName.pnl,
      (requestId: number, dailyPnl: number, unrealizedPnl?: number, realizedPnl?: number) => {
        if (requestId !== ACCOUNT_PNL_REQUEST_ID || !this.subscribedPnlAccountId) return
        const accountId = this.subscribedPnlAccountId
        const summary = this.accountSummaries.get(accountId)
        if (!summary) return
        this.accountSummaries.set(accountId, {
          ...summary,
          dailyPnl: finiteNumber(dailyPnl),
          unrealizedPnl: finiteNumber(unrealizedPnl),
          realizedPnl: finiteNumber(realizedPnl),
        })
        this.flushAccounts()
      },
    )
    this.ib.on(
      EventName.position,
      (account: string, contract: Contract, position: number, avgCost?: number) => {
        const incoming = fromIbPosition(account, contract, position, avgCost ?? 0)
        const existing = this.store.getState().positions.find((item) => item.id === incoming.id)
        const symbol = this.symbolFromContract(contract, existing?.symbol)
        this.store.upsertPosition({
          ...incoming,
          symbol,
          optionContract:
            symbol.assetClass === 'event-contract'
              ? undefined
              : optionContractWithSourceIdentity(incoming.optionContract, symbol),
        })
      },
    )
    this.ib.on(
      EventName.updatePortfolio,
      (
        contract: Contract,
        position: number,
        marketPrice: number,
        marketValue: number,
        averageCost?: number,
        unrealizedPNL?: number,
        realizedPNL?: number,
        accountName?: string,
      ) => {
        const accountId = accountName ?? this.store.getState().activeAccountId
        if (!accountId) return
        const pnlCurrency =
          this.accountSummaries.get(accountId)?.currency ??
          this.store.getState().accounts.find((account) => account.id === accountId)?.currency
        const incoming = fromIbPosition(accountId, contract, position, averageCost ?? 0)
        const existing = this.store.getState().positions.find((item) => item.id === incoming.id)
        const symbol = this.symbolFromContract(contract, existing?.symbol)
        this.store.upsertPosition({
          ...incoming,
          symbol,
          optionContract:
            symbol.assetClass === 'event-contract'
              ? undefined
              : optionContractWithSourceIdentity(incoming.optionContract, symbol),
          markPrice: finiteNumber(marketPrice),
          marketValue: finiteNumber(marketValue),
          unrealizedPnl: finiteNumber(unrealizedPNL),
          realizedPnl: finiteNumber(realizedPNL),
          pnlCurrency,
        })
      },
    )
  }
  private readonly accountSummaries = new Map<string, AccountSummary>()

  private subscribedPortfolioAccountId?: string | undefined

  private subscribedPnlAccountId?: string | undefined

  private flushAccounts(): void {
    this.store.setAccounts([...this.accountSummaries.values()])
    this.subscribePortfolioAccount(this.store.getState().activeAccountId)
    this.subscribeAccountPnl(this.store.getState().activeAccountId)
  }

  subscribePortfolioAccount(accountId: string | undefined): void {
    if (
      this.store.getState().connectionStatus !== 'connected' ||
      this.subscribedPortfolioAccountId === accountId
    )
      return
    if (this.subscribedPortfolioAccountId) {
      this.ib.reqAccountUpdates(false, this.subscribedPortfolioAccountId)
    }
    this.subscribedPortfolioAccountId = undefined
    if (!accountId) return
    this.ib.reqAccountUpdates(true, accountId)
    this.subscribedPortfolioAccountId = accountId
  }

  subscribeAccountPnl(accountId: string | undefined): void {
    if (
      this.store.getState().connectionStatus !== 'connected' ||
      this.subscribedPnlAccountId === accountId
    )
      return
    if (this.subscribedPnlAccountId) {
      this.ib.cancelPnL(ACCOUNT_PNL_REQUEST_ID)
    }
    this.subscribedPnlAccountId = undefined
    if (!accountId) return
    this.ib.reqPnL(ACCOUNT_PNL_REQUEST_ID, accountId)
    this.subscribedPnlAccountId = accountId
  }
}
