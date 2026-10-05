import type { BrokerState } from '@ibkr-terminal/contracts'

/** Runs inside the page; only static mismatch categories leave the browser. */
export async function currentAccountPanelMismatches(
  phase: 'summary' | 'account' | 'position-pnl',
): Promise<string[]> {
  const driver = window.__ibkrChartTradingE2E__
  if (!driver) return ['Native SDK account snapshot unavailable']
  const controller = await driver.getPaperTradingController()
  const [response, native] = await Promise.all([
    fetch('/api/v1/ibkr/state', { headers: { 'x-tradescript-client': 'terminal-v1' } }),
    controller.getState(),
  ])
  if (!response.ok) return ['Broker account snapshot unavailable']
  const broker: BrokerState = await response.json()
  if (
    broker.connectionStatus !== 'connected' ||
    native.connectionStatus !== 'connected' ||
    !broker.activeAccountId ||
    broker.activeAccountId !== native.activeAccountId
  )
    return ['Current broker and native SDK account differ']
  const account = broker.accounts.find((row) => row.id === broker.activeAccountId)
  const sdkAccount = native.accounts.find((row) => row.id === native.activeAccountId)
  if (!account || !sdkAccount || !account.currency || sdkAccount.currency !== account.currency)
    return ['Current account currency or identity unavailable']
  const fields = [
    ['Cash', account.cash, sdkAccount.balance?.cash],
    ['Net Liquidation', account.netLiquidation, sdkAccount.balance?.equity],
    ['Buying Power', account.buyingPower, sdkAccount.balance?.buyingPower],
    ['Available Funds', account.availableFunds, sdkAccount.customFields?.availableFunds],
    ['Initial Margin Requirement', account.marginUsed, sdkAccount.balance?.marginUsed],
    [
      'Maintenance Margin Requirement',
      account.maintenanceMargin,
      sdkAccount.balance?.maintenanceMargin,
    ],
  ] as const
  const pnl = [
    ['Daily P&L', account.dailyPnl, sdkAccount.customFields?.dailyPnl],
    ['Unrealized P&L', account.unrealizedPnl, sdkAccount.customFields?.unrealizedPnl],
    ['Realized P&L', account.realizedPnl, sdkAccount.customFields?.realizedPnl],
  ] as const
  const mismatches: string[] = []
  for (const [label, value, sdkValue] of fields)
    if (!Number.isFinite(value) || value !== sdkValue)
      mismatches.push(`${label}: broker/native facts differ`)
  for (const [label, value, sdkValue] of pnl)
    if ((value !== undefined && !Number.isFinite(value)) || value !== sdkValue)
      mismatches.push(`${label}: broker/native facts differ`)
  if (mismatches.length) return mismatches

  // Give the mounted renderer a frame to apply the native snapshot. Re-read every
  // attempt instead of retaining an amount while live provider updates continue.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const panel = document.querySelector('[role="region"][aria-label="Portfolio & Activity"]')
  if (!panel) return ['Account panel is absent']
  const money = (value: number, currency = account.currency) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value)
  const panelText =
    'innerText' in panel && typeof panel.innerText === 'string' ? panel.innerText : ''
  const rows = Array.from(panel.querySelectorAll('[role="row"], tr'))
    .filter((row) => row.getClientRects().length > 0)
    .map((row) =>
      Array.from(row.querySelectorAll('[role="cell"], td')).map(
        (cell) => cell.textContent?.trim() ?? '',
      ),
    )
  if (phase === 'summary') {
    const text = panelText
    for (const [label, value] of [fields[0], fields[1], fields[2], fields[4]])
      if (!text.includes(money(Number(value)))) mismatches.push(`${label}: summary differs`)
    return mismatches
  }
  if (phase === 'account') {
    for (const [label, value] of fields)
      if (!rows.some((cells) => cells[0] === label && cells[1] === money(Number(value))))
        mismatches.push(`${label}: rendered row differs`)
    for (const [label, value] of pnl) {
      const matching = rows.filter((cells) => cells[0] === label)
      if (value === undefined) {
        if (matching.length) mismatches.push(`${label}: unavailable row was invented`)
        continue
      }
      const text = matching[0]?.[1]
      const currencySymbol = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: account.currency,
      })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value
      const rendered =
        text === undefined ? Number.NaN : Number(text.replace(/[^\d,.-]/gu, '').replaceAll(',', ''))
      if (
        matching.length !== 1 ||
        !currencySymbol ||
        !text?.includes(currencySymbol) ||
        !Number.isFinite(rendered) ||
        Math.abs(rendered - value) > 0.005
      )
        mismatches.push(`${label}: rendered amount or currency differs`)
    }
    if (pnl.every(([, value]) => value === undefined) && !panelText.includes('No account P&L'))
      mismatches.push('Unavailable account P&L empty state is absent')
    if (!(Number(account.netLiquidation) > 0))
      return [...mismatches, 'Current equity denominator is unavailable']
    for (const [label, numerator] of [
      ['Available Funds / Net Liquidation', account.availableFunds],
      ['Buying Power / Net Liquidation', account.buyingPower],
    ] as const)
      if (
        !rows.some(
          (cells) =>
            cells[0] === label &&
            cells[1] ===
              `${((Number(numerator) / Number(account.netLiquidation)) * 100).toFixed(2)}%`,
        )
      )
        mismatches.push(`${label}: rendered ratio differs`)
  }
  const positions = broker.positions.filter((position) => position.accountId === account.id)
  for (const position of positions) {
    const sdkPosition = native.positions.find(
      (row) => row.id === position.id && row.accountId === account.id,
    )
    if (
      !sdkPosition ||
      sdkPosition.quantity !== Math.abs(position.quantity) ||
      sdkPosition.customFields?.marketValue !== position.marketValue ||
      sdkPosition.symbol.type !== position.symbol.assetClass ||
      sdkPosition.symbol.currency !== position.symbol.currency ||
      sdkPosition.symbol.canonicalSymbol !== position.symbol.canonicalSymbol
    ) {
      mismatches.push('Current position broker/native facts differ')
      continue
    }
    if (phase === 'account') {
      if (
        !Number.isFinite(position.marketValue) ||
        !position.symbol.currency ||
        !rows.some(
          (cells) =>
            cells[0] === sdkPosition.symbol.ticker &&
            cells[1] === money(Number(position.marketValue), position.symbol.currency) &&
            Number(cells[2]?.replaceAll(',', '')) === Math.abs(position.quantity),
        )
      )
        mismatches.push('Current position exposure row differs')
    } else if (
      position.pnlCurrency &&
      position.pnlCurrency !== position.symbol.currency &&
      Number.isFinite(position.unrealizedPnl)
    ) {
      const value = Number(position.unrealizedPnl)
      const formatted = `${value > 0 ? '+' : ''}${money(value, position.pnlCurrency)}`
      if (
        sdkPosition.unrealizedPnl !== value ||
        sdkPosition.pnlCurrency !== position.pnlCurrency ||
        sdkPosition.customFields?.pnlCurrency !== position.pnlCurrency ||
        !rows.some(
          (cells) => cells.includes(sdkPosition.symbol.ticker) && cells.includes(formatted),
        )
      )
        mismatches.push('Current position P&L amount or currency differs')
    }
  }
  return mismatches
}
