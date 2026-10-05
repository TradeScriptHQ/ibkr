import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AccountSummary, BrokerState } from '@ibkr-terminal/contracts'
import type { TradingState } from '@tradescript/pro/sdk'
import { currentAccountPanelMismatches } from './account-panel-check.js'

const account: AccountSummary = {
  id: 'DU-synthetic-account',
  label: 'Synthetic paper',
  currency: 'USD',
  cash: 10,
  netLiquidation: 100,
  buyingPower: 200,
  availableFunds: 50,
  marginUsed: 2,
  maintenanceMargin: 1,
  dailyPnl: 3,
  unrealizedPnl: 4,
  realizedPnl: 5,
}
function brokerState(extra: Partial<AccountSummary> = {}): BrokerState {
  return {
    connectionStatus: 'connected',
    activeAccountId: account.id,
    accounts: [{ ...account, ...extra }],
    orders: [],
    positions: [],
    executions: [],
    quotes: [],
    messages: [],
    diagnostics: [],
    updatedAt: '2026-09-30T10:00:00Z',
  }
}
function nativeState(broker: BrokerState): TradingState {
  const value = broker.accounts[0]!
  return {
    connectionStatus: 'connected',
    activeAccountId: value.id,
    accounts: [
      {
        id: value.id,
        name: value.label,
        currency: value.currency,
        balance: {
          ...(value.cash === undefined ? {} : { cash: value.cash }),
          ...(value.netLiquidation === undefined ? {} : { equity: value.netLiquidation }),
          ...(value.buyingPower === undefined ? {} : { buyingPower: value.buyingPower }),
          ...(value.marginUsed === undefined ? {} : { marginUsed: value.marginUsed }),
          ...(value.maintenanceMargin === undefined
            ? {}
            : { maintenanceMargin: value.maintenanceMargin }),
        },
        customFields: {
          availableFunds: value.availableFunds,
          dailyPnl: value.dailyPnl,
          unrealizedPnl: value.unrealizedPnl,
          realizedPnl: value.realizedPnl,
        },
      },
    ],
    positions: [],
    orders: [],
    executions: [],
  }
}
function renderedRows(value: AccountSummary) {
  const money = (amount: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: value.currency }).format(amount)
  return [
    ...(
      [
        ['Cash', value.cash],
        ['Net Liquidation', value.netLiquidation],
        ['Buying Power', value.buyingPower],
        ['Available Funds', value.availableFunds],
        ['Initial Margin Requirement', value.marginUsed],
        ['Maintenance Margin Requirement', value.maintenanceMargin],
        ['Daily P&L', value.dailyPnl],
        ['Unrealized P&L', value.unrealizedPnl],
        ['Realized P&L', value.realizedPnl],
      ] as const
    ).flatMap(([label, amount]) => (amount === undefined ? [] : [[label, money(amount)]])),
    [
      'Available Funds / Net Liquidation',
      `${((Number(value.availableFunds) / Number(value.netLiquidation)) * 100).toFixed(2)}%`,
    ],
    [
      'Buying Power / Net Liquidation',
      `${((Number(value.buyingPower) / Number(value.netLiquidation)) * 100).toFixed(2)}%`,
    ],
  ]
}
function fixture(
  broker: BrokerState,
  native: TradingState,
  rows = renderedRows(broker.accounts[0]!),
) {
  const saved = new Map(
    ['window', 'document', 'fetch', 'requestAnimationFrame'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  )
  const panel = {
    textContent: `${rows.flat().join(' ')}${broker.accounts[0]?.dailyPnl === undefined && broker.accounts[0]?.unrealizedPnl === undefined && broker.accounts[0]?.realizedPnl === undefined ? ' No account P&L' : ''}`,
    innerText: `${rows.flat().join(' ')}${broker.accounts[0]?.dailyPnl === undefined && broker.accounts[0]?.unrealizedPnl === undefined && broker.accounts[0]?.realizedPnl === undefined ? ' No account P&L' : ''}`,
    querySelectorAll: () =>
      rows.map((cells) => ({
        getClientRects: () => [{}],
        querySelectorAll: () => cells.map((textContent) => ({ textContent })),
      })),
  }
  const values = {
    window: {
      __ibkrChartTradingE2E__: {
        getPaperTradingController: async () => ({ getState: async () => native }),
      },
    },
    document: { querySelector: () => panel },
    fetch: async () => Response.json(broker),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    },
  }
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('fresh coherent provider, native account and rendered rows satisfy every account metric', async () => {
  const broker = brokerState(),
    native = nativeState(broker)
  const restore = fixture(broker, native)
  try {
    assert.deepEqual(await currentAccountPanelMismatches('summary'), [])
    assert.deepEqual(await currentAccountPanelMismatches('account'), [])
  } finally {
    restore()
  }
})

test('a stale native snapshot cannot be mistaken for fresh provider reconciliation', async () => {
  const broker = brokerState({ netLiquidation: 101 }),
    native = nativeState(brokerState())
  const restore = fixture(broker, native)
  try {
    assert.deepEqual(await currentAccountPanelMismatches('account'), [
      'Net Liquidation: broker/native facts differ',
    ])
  } finally {
    restore()
  }
})

test('a live metric change is checked against a new snapshot instead of a frozen row amount', async () => {
  for (const equity of [100, 101]) {
    const broker = brokerState({ netLiquidation: equity }),
      native = nativeState(broker)
    const restore = fixture(broker, native)
    try {
      assert.deepEqual(await currentAccountPanelMismatches('account'), [])
    } finally {
      restore()
    }
  }
})

test('current native/provider agreement never accepts an obsolete rendered value', async () => {
  const broker = brokerState({ netLiquidation: 101 }),
    native = nativeState(broker)
  const restore = fixture(broker, native, renderedRows(account))
  try {
    const failures = await currentAccountPanelMismatches('account')
    assert(failures.includes('Net Liquidation: rendered row differs'))
    assert(failures.includes('Buying Power / Net Liquidation: rendered ratio differs'))
    assert(failures.every((value) => !value.includes(account.id) && !/\$|\d/u.test(value)))
  } finally {
    restore()
  }
})

test('different active accounts fail with only a static identity category', async () => {
  const broker = brokerState(),
    native = nativeState(broker)
  native.activeAccountId = 'DU-other-synthetic'
  const restore = fixture(broker, native)
  try {
    assert.deepEqual(await currentAccountPanelMismatches('summary'), [
      'Current broker and native SDK account differ',
    ])
  } finally {
    restore()
  }
})

test('unavailable P&L remains absent and missing required facts cannot invent zero', async () => {
  const broker = brokerState({
      dailyPnl: undefined,
      unrealizedPnl: undefined,
      realizedPnl: undefined,
    }),
    native = nativeState(broker)
  let restore = fixture(broker, native)
  try {
    assert.deepEqual(await currentAccountPanelMismatches('account'), [])
  } finally {
    restore()
  }
  broker.accounts[0]!.netLiquidation = undefined
  delete native.accounts[0]!.balance!.equity
  restore = fixture(broker, native)
  try {
    assert.deepEqual(await currentAccountPanelMismatches('account'), [
      'Net Liquidation: broker/native facts differ',
    ])
  } finally {
    restore()
  }
})

function positionFixture() {
  const broker = brokerState(),
    native = nativeState(broker)
  broker.positions.push({
    id: 'synthetic-position',
    accountId: account.id,
    quantity: 1,
    symbol: {
      symbol: 'SYNTHETIC',
      canonicalSymbol: 'IBKR:500',
      assetClass: 'stock',
      currency: 'USD',
    },
    marketValue: 10,
    unrealizedPnl: 3,
    pnlCurrency: 'EUR',
  })
  native.positions.push({
    id: 'synthetic-position',
    accountId: account.id,
    quantity: 1,
    side: 'long',
    symbol: { ticker: 'SYNTHETIC', canonicalSymbol: 'IBKR:500', type: 'stock', currency: 'USD' },
    unrealizedPnl: 3,
    pnlCurrency: 'EUR',
    customFields: { marketValue: 10, pnlCurrency: 'EUR' },
  })
  return { broker, native }
}

test('position exposure uses fresh native identity and quantity instead of a frozen monetary row', async () => {
  const { broker, native } = positionFixture()
  let restore = fixture(broker, native, [...renderedRows(account), ['SYNTHETIC', '$10.00', '1']])
  try {
    assert.deepEqual(await currentAccountPanelMismatches('account'), [])
  } finally {
    restore()
  }
  native.positions[0]!.quantity = 2
  restore = fixture(broker, native, [...renderedRows(account), ['SYNTHETIC', '$10.00', '2']])
  try {
    assert.deepEqual(await currentAccountPanelMismatches('position-pnl'), [
      'Current position broker/native facts differ',
    ])
  } finally {
    restore()
  }
})

test('mixed-currency position P&L must render the retained P&L currency', async () => {
  const { broker, native } = positionFixture()
  let restore = fixture(broker, native, [['SYNTHETIC', '+€3.00']])
  try {
    assert.deepEqual(await currentAccountPanelMismatches('position-pnl'), [])
  } finally {
    restore()
  }
  delete native.positions[0]!.pnlCurrency
  restore = fixture(broker, native, [['SYNTHETIC', '+€3.00']])
  try {
    assert.deepEqual(await currentAccountPanelMismatches('position-pnl'), [
      'Current position P&L amount or currency differs',
    ])
  } finally {
    restore()
  }
  native.positions[0]!.pnlCurrency = 'EUR'
  restore = fixture(broker, native, [['SYNTHETIC', '+$3.00']])
  try {
    assert.deepEqual(await currentAccountPanelMismatches('position-pnl'), [
      'Current position P&L amount or currency differs',
    ])
  } finally {
    restore()
  }
})
