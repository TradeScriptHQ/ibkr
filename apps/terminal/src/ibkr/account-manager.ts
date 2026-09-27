import type {
  TradingAccount,
  TradingAccountManagerInfo,
  TradingAccountManagerTableDataRequest,
  TradingPosition,
  TradingState,
} from '@tradescript/pro/sdk'

type AccountManagerMetricRow = {
  id: string
  metric: string
  value?: number | string | undefined
  quantity?: number | undefined
  currency?: string | undefined
  formatter?: string | undefined
}

export function withIbkrAccountManagerPages(
  info: TradingAccountManagerInfo,
): TradingAccountManagerInfo {
  return {
    ...info,
    pages: [
      ...(info.pages ?? []),
      {
        id: 'account',
        title: 'Account',
        tables: [
          {
            id: 'balances',
            title: 'Balances',
            source: 'custom',
            columns: [
              { id: 'metric', label: 'Metric', dataFields: ['metric'], formatter: 'text' },
              {
                id: 'value',
                label: 'Value',
                dataFields: ['value', 'currency'],
                formatter: 'money',
                alignment: 'right',
              },
            ],
            emptyMessage: 'No account balances',
          },
          {
            id: 'pnl',
            title: 'P&L',
            source: 'custom',
            columns: [
              { id: 'metric', label: 'Metric', dataFields: ['metric'], formatter: 'text' },
              {
                id: 'value',
                label: 'Value',
                dataFields: ['value', 'currency'],
                formatter: 'signed-money',
                alignment: 'right',
                highlightDiff: true,
              },
            ],
            emptyMessage: 'No account P&L',
          },
          {
            id: 'margin',
            title: 'Margin',
            source: 'custom',
            columns: [
              { id: 'metric', label: 'Metric', dataFields: ['metric'], formatter: 'text' },
              {
                id: 'value',
                label: 'Value',
                dataFields: ['value'],
                formatter: 'margin-percent',
                alignment: 'right',
              },
            ],
            emptyMessage: 'No margin metrics',
          },
          {
            id: 'position-exposure',
            title: 'Position Exposure',
            source: 'custom',
            columns: [
              { id: 'metric', label: 'Position', dataFields: ['metric'], formatter: 'text' },
              {
                id: 'value',
                label: 'Market Value',
                dataFields: ['value', 'currency'],
                formatter: 'money',
                alignment: 'right',
              },
              {
                id: 'quantity',
                label: 'Qty',
                dataFields: ['quantity'],
                formatter: 'variable-number',
                alignment: 'right',
              },
            ],
            emptyMessage: 'No position exposure',
          },
        ],
      },
    ],
  }
}

export function ibkrAccountManagerRows(
  state: TradingState,
  request: TradingAccountManagerTableDataRequest,
): AccountManagerMetricRow[] {
  const account =
    state.accounts.find((candidate) => candidate.id === request.accountId) ??
    state.accounts.find((candidate) => candidate.isActive) ??
    state.accounts[0]
  if (request.tableId === 'balances') {
    return [
      { id: 'cash', metric: 'Cash', value: account?.balance?.cash, currency: account?.currency },
      {
        id: 'equity',
        metric: 'Net Liquidation',
        value: account?.balance?.equity,
        currency: account?.currency,
      },
      {
        id: 'buyingPower',
        metric: 'Buying Power',
        value: account?.balance?.buyingPower,
        currency: account?.currency,
      },
      {
        id: 'availableFunds',
        metric: 'Available Funds',
        value: numberCustomField(account, 'availableFunds'),
        currency: account?.currency,
      },
      {
        id: 'marginUsed',
        metric: 'Initial Margin Requirement',
        value: account?.balance?.marginUsed,
        currency: account?.currency,
      },
      {
        id: 'maintenanceMargin',
        metric: 'Maintenance Margin Requirement',
        value: account?.balance?.maintenanceMargin,
        currency: account?.currency,
      },
    ].filter((row) => row.value !== undefined)
  }
  if (request.tableId === 'pnl') {
    return [
      {
        id: 'dailyPnl',
        metric: 'Daily P&L',
        value: numberCustomField(account, 'dailyPnl'),
        currency: account?.currency,
      },
      {
        id: 'unrealizedPnl',
        metric: 'Unrealized P&L',
        value: numberCustomField(account, 'unrealizedPnl'),
        currency: account?.currency,
      },
      {
        id: 'realizedPnl',
        metric: 'Realized P&L',
        value: numberCustomField(account, 'realizedPnl'),
        currency: account?.currency,
      },
    ].filter((row) => row.value !== undefined)
  }
  if (request.tableId === 'margin') {
    const equity = account?.balance?.equity
    const buyingPower = account?.balance?.buyingPower
    const availableFunds = numberCustomField(account, 'availableFunds')
    return [
      {
        id: 'availableFundsRatio',
        metric: 'Available Funds / Net Liquidation',
        value: ratioPercent(availableFunds, equity),
      },
      {
        id: 'buyingPowerRatio',
        metric: 'Buying Power / Net Liquidation',
        value: ratioPercent(buyingPower, equity),
      },
    ].filter((row) => row.value !== undefined)
  }
  if (request.tableId === 'position-exposure') {
    return state.positions
      .filter((position) => !request.accountId || position.accountId === request.accountId)
      .map((position) => ({
        id: position.id,
        metric: position.symbol.ticker,
        value: numberCustomField(position, 'marketValue'),
        quantity: position.quantity,
        currency: position.currency,
      }))
      .filter((row) => row.value !== undefined)
  }
  return []
}

function numberCustomField(
  record: Pick<TradingAccount | TradingPosition, 'customFields'> | undefined,
  field: string,
): number | undefined {
  const value = record?.customFields?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function ratioPercent(
  numerator: number | undefined,
  denominator: number | undefined,
): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !denominator) return undefined
  return (Number(numerator) / Number(denominator)) * 100
}
