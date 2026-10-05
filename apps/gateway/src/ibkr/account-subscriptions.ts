import type { Contract } from '@stoqey/ib'
import { EventName, type IBApi } from '@stoqey/ib'
import { finiteNumber } from './numbers.js'
import { optionContractWithSourceIdentity } from './option-chain.js'
import { fromIbPosition } from './orders.js'
import type { BrokerStateStore } from './state-store.js'
import type { AccountSummary, BrokerSymbol } from './types.js'

/** Owns account summaries, portfolio/PnL subscriptions and account event decoding. */
export class AccountSubscriptions {
  constructor(
    private readonly ib: IBApi,
    private readonly store: BrokerStateStore,
    private readonly symbolFromContract: (
      contract: Contract,
      preferred?: BrokerSymbol,
    ) => BrokerSymbol,
    private readonly allocateRequestId: () => number,
    private readonly allowedAccountIds: readonly string[],
  ) {
    this.registerHandlers()
  }
  clear(): void {
    this.subscribedPortfolioAccountId = undefined
    this.subscribedPnlAccountId = undefined
    this.subscribedPnlRequestId = undefined
    this.snapshotPositions = undefined
  }
  portfolioSubscriptionLost(): void {
    const accountId = this.subscribedPortfolioAccountId
    this.subscribedPortfolioAccountId = undefined
    if (accountId) this.store.invalidatePortfolio(accountId)
  }
  beginReconciliation(): void {
    this.snapshotPositions = new Set()
  }
  finishReconciliation(): void {
    if (this.snapshotPositions) {
      for (const position of this.store.getState().positions) {
        if (this.managedAccountIds && !this.managedAccountIds.has(position.accountId))
          this.snapshotPositions.delete(position.id)
      }
      this.store.reconcilePositions(this.snapshotPositions)
    }
    this.snapshotPositions = undefined
  }
  private registerHandlers(): void {
    this.ib.on(EventName.managedAccounts, (accountsList: string) => {
      const accountIds = accountsList
        .split(',')
        .map((account) => account.trim())
        .filter(Boolean)
      const managedAccounts = new Set(accountIds)
      this.managedAccountIds = managedAccounts
      for (const accountId of this.accountSummaries.keys()) {
        if (!managedAccounts.has(accountId)) this.accountSummaries.delete(accountId)
      }
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
        if (this.managedAccountIds && !this.managedAccountIds.has(account)) return
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
        if (requestId !== this.subscribedPnlRequestId || !this.subscribedPnlAccountId) return
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
        if (
          !this.snapshotPositions &&
          this.managedAccountIds &&
          !this.managedAccountIds.has(account)
        )
          return
        const incoming = fromIbPosition(account, contract, position, avgCost ?? 0)
        if (position === 0) this.snapshotPositions?.delete(incoming.id)
        else this.snapshotPositions?.add(incoming.id)
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
        if (
          !this.snapshotPositions &&
          this.managedAccountIds &&
          !this.managedAccountIds.has(accountId)
        )
          return
        const pnlCurrency =
          this.accountSummaries.get(accountId)?.currency ??
          this.store.getState().accounts.find((account) => account.id === accountId)?.currency
        const incoming = fromIbPosition(accountId, contract, position, averageCost ?? 0)
        if (position === 0) this.snapshotPositions?.delete(incoming.id)
        else this.snapshotPositions?.add(incoming.id)
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
  private managedAccountIds: Set<string> | undefined
  private snapshotPositions: Set<string> | undefined

  private subscribedPortfolioAccountId?: string | undefined

  private subscribedPnlAccountId?: string | undefined
  private subscribedPnlRequestId?: number | undefined

  private flushAccounts(): void {
    const accounts = [...this.accountSummaries.values()]
    const selected = this.store.getState().activeAccountId
    const allowed = accounts.filter((account) => this.allowedAccountIds.includes(account.id))
    const activeAccountId = allowed.find((account) => account.id === selected)?.id ?? allowed[0]?.id
    this.store.setAccounts(accounts, activeAccountId ?? null)
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
    if (this.subscribedPnlRequestId !== undefined) {
      this.ib.cancelPnL(this.subscribedPnlRequestId)
    }
    this.subscribedPnlAccountId = undefined
    this.subscribedPnlRequestId = undefined
    if (!accountId) return
    const requestId = this.allocateRequestId()
    this.subscribedPnlRequestId = requestId
    this.subscribedPnlAccountId = accountId
    this.ib.reqPnL(requestId, accountId)
  }
}
