import type { ConnectionSettings, ConnectionSnapshot } from '@ibkr-terminal/contracts'
import { expect, type Page, type Route, test } from '@playwright/test'
import type { AgentRiskAvailability } from '../../apps/terminal/src/workstation-agent-risk.js'
import { exposeConnectionControls } from '../support/connection-ui.js'

// Only this browser's connection policy is synthetic. Every policy write is intercepted;
// these tests never enable agents on the running broker or reconnect its session.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const blockedBrokerRequests = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
  test.info().annotations.push({
    type: 'qualification',
    description: 'Synthetic readiness and policy writes; every broker request is blocked.',
  })
  const methods: string[] = []
  blockedBrokerRequests.set(page, methods)
  await page.route('**/api/v1/ibkr/**', (route) => {
    methods.push(route.request().method())
    return route.abort('blockedbyclient')
  })
  await exposeConnectionControls(page)
})
test.afterEach(async ({ page }) => {
  // Keep the abort guard installed until polling and pending requests have stopped.
  await page.close()
  expect(blockedBrokerRequests.get(page)?.every((method) => method === 'GET')).toBe(true)
})

type AgentLimits = NonNullable<ConnectionSettings['profiles']['paper']['limits']>
type AgentTradingRequest = {
  enabled: boolean
  generation: string
  expectedAgentTradingRevision: number
  limits?: AgentLimits
}

const LIMITS: AgentLimits = {
  maxOrderQuantity: 1,
  maxOrderNotional: 1_000,
  maxPositionQuantity: 2,
  maxPositionNotional: 2_000,
  maxGrossExposure: 5_000,
  maxDailyLoss: 100,
  maxOrdersPerMinute: 2,
  maxEstimatedSlippageBps: 10,
  maxMarketDataAgeMs: 5_000,
  maxLeverage: 1,
  maxUnprotectedPositionQuantity: 1,
}

const CONSERVATIVE_LIMITS: AgentLimits = {
  maxOrderQuantity: null,
  maxOrderNotional: 500,
  maxPositionQuantity: null,
  maxPositionNotional: 2_000,
  maxGrossExposure: 5_000,
  maxDailyLoss: 100,
  maxOrdersPerMinute: 5,
  maxEstimatedSlippageBps: 10,
  maxMarketDataAgeMs: 5_000,
  maxLeverage: 1,
  maxUnprotectedPositionQuantity: null,
}
const NORMAL_LIMITS: AgentLimits = {
  ...CONSERVATIVE_LIMITS,
  maxOrderNotional: 2_500,
  maxPositionNotional: 10_000,
  maxGrossExposure: 25_000,
  maxDailyLoss: 500,
  maxOrdersPerMinute: 10,
}
const AGGRESSIVE_LIMITS: AgentLimits = {
  ...CONSERVATIVE_LIMITS,
  maxOrderNotional: 10_000,
  maxPositionNotional: 25_000,
  maxGrossExposure: 100_000,
  maxDailyLoss: 2_000,
  maxOrdersPerMinute: 20,
}

function withoutQuantityLimits(limits: AgentLimits): AgentLimits {
  return {
    ...limits,
    maxOrderQuantity: null,
    maxPositionQuantity: null,
    maxUnprotectedPositionQuantity: null,
  }
}

async function expectVisibleLimits(page: Page, limits: AgentLimits) {
  const dialog = page.getByRole('dialog', { name: 'Agent trading limits', exact: true })
  for (const label of [
    'Maximum order quantity',
    'Maximum position quantity',
    'Maximum unprotected position quantity',
  ]) {
    await expect(dialog.getByRole('spinbutton', { name: label, exact: true })).toHaveCount(0)
  }
  for (const [label, value] of [
    ['Maximum order value', limits.maxOrderNotional],
    ['Maximum position value', limits.maxPositionNotional],
    ['Maximum gross account exposure', limits.maxGrossExposure],
    ['Maximum daily loss', limits.maxDailyLoss],
    ['Maximum orders per minute', limits.maxOrdersPerMinute],
    ['Maximum slippage (basis points)', limits.maxEstimatedSlippageBps],
    ['Maximum quote age (milliseconds)', limits.maxMarketDataAgeMs],
    ['Maximum leverage', limits.maxLeverage],
  ] as const) {
    const input =
      label === 'Maximum gross account exposure'
        ? dialog.getByRole('spinbutton', { name: /^Maximum gross account exposure/u })
        : dialog.getByRole('spinbutton', { name: label, exact: true })
    await expect(input).toHaveValue(value === undefined ? '' : String(value))
  }
}

async function interceptAgentTrading(
  page: Page,
  {
    enabled = false,
    limits = LIMITS,
    allowedAccountIds = ['DU-FIXTURE'],
    onWrite,
  }: {
    enabled?: boolean
    limits?: AgentLimits | null
    allowedAccountIds?: string[]
    onWrite?: (route: Route, body: AgentTradingRequest) => Promise<boolean | undefined>
  } = {},
) {
  const profile = {
    connectionType: 'tws' as const,
    port: 7497,
    clientId: 71,
    allowedAccountIds,
    agentTradingEnabled: enabled,
    ...(limits ? { limits } : {}),
  }
  const snapshot: ConnectionSnapshot = {
    generation: 'synthetic-agent-trading',
    agentTradingRevision: 0,
    settings: {
      active: 'paper',
      profiles: {
        paper: profile,
        live: { ...profile, port: 7496, allowedAccountIds: [], agentTradingEnabled: false },
      },
    },
  }
  const writes: AgentTradingRequest[] = []
  const connectionChanges: string[] = []
  await page.route('**/api/v1/connection', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: snapshot })
    connectionChanges.push(route.request().method())
    return route.fulfill({ status: 500, json: { error: { message: 'Unexpected reconnect' } } })
  })
  await page.route('**/api/v1/connection/test', (route) => {
    connectionChanges.push('test')
    return route.fulfill({
      status: 500,
      json: { error: { message: 'Unexpected connection test' } },
    })
  })
  await page.route('**/api/v1/connection/agent-trading', async (route) => {
    expect(route.request().method()).toBe('PUT')
    const body = route.request().postDataJSON() as AgentTradingRequest
    writes.push(body)
    if (await onWrite?.(route, body)) return
    snapshot.settings.profiles.paper.agentTradingEnabled = body.enabled
    if (body.limits) snapshot.settings.profiles.paper.limits = body.limits
    snapshot.agentTradingRevision = (snapshot.agentTradingRevision ?? 0) + 1
    return route.fulfill({ json: snapshot })
  })
  return { writes, connectionChanges, snapshot }
}

async function interceptWorkstationRisk(page: Page, agentRisk: AgentRiskAvailability) {
  const status = {
    service: 'ibkr-trading-gateway',
    version: 'agent-risk-ui-fixture',
    environment: 'paper',
    ready: true,
    tradingEnabled: true,
    generatedAt: new Date().toISOString(),
    requirements: [],
  }
  await page.route('**/api/v1/session/bootstrap', (route) =>
    route.fulfill({
      json: {
        csrfToken: 'synthetic-agent-risk-ui-csrf-token-at-least-32-characters',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  )
  await page.route('**/api/v1/tradescript/**', (route) => route.abort('blockedbyclient'))
  await page.route('**/mcp-local/**', (route) => route.abort('blockedbyclient'))
  // Replace only the startup boundary. App, its real hook, toolbar, and tooltip still render;
  // no SDK, lease, risk authority, or broker operation is allocated by this fixture.
  await page.route('**/src/workstation.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        export function createWorkstation({ host, setLoadState }) {
          const starts = Number(document.documentElement.dataset.syntheticAgentRiskStarts ?? '0');
          document.documentElement.dataset.syntheticAgentRiskStarts = String(starts + 1);
          host?.setAttribute('data-synthetic-agent-risk-workstation', 'mounted');
          setLoadState({ state: 'ready', status: ${JSON.stringify(status)}, agentRisk: ${JSON.stringify(agentRisk)} });
          return {
            started: Promise.resolve(),
            async dispose() {
              host?.removeAttribute('data-synthetic-agent-risk-workstation');
            },
          };
        }
      `,
    }),
  )
}

test('pending agent checks stay in the toolbar while the workspace is available', async ({
  page,
}) => {
  await interceptAgentTrading(page, { enabled: true })
  await interceptWorkstationRisk(page, { state: 'checking' })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Chart data', exact: true })).toBeEnabled()
  await expect(page.locator('.agent-risk-pending')).toHaveText('Checking agent…')
  await expect(page.locator('.agent-risk-pending')).toHaveAttribute('role', 'status')
  await expect(page.getByText('Starting workstation', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Agent trading paused', exact: true })).toHaveCount(
    0,
  )
})

test('unavailable agent risk uses a compact warning with hover and keyboard explanation', async ({
  page,
}) => {
  const message = 'Synthetic account currency conversion is unavailable.'
  const { writes, connectionChanges } = await interceptAgentTrading(page, { enabled: true })
  await interceptWorkstationRisk(page, { state: 'unavailable', message })
  await page.goto('/')
  const control = page.locator('.agent-trading-control')
  const warning = control.getByRole('button', { name: 'Agent trading paused', exact: true })
  const tooltip = page.getByRole('tooltip')
  await expect(page.getByRole('button', { name: 'Chart data', exact: true })).toBeEnabled()
  await expect(warning).toBeVisible()
  await expect(page.locator('.agent-risk-notice')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry agent checks', exact: true })).toHaveCount(0)
  await expect(tooltip).toBeHidden()

  await warning.hover()
  await expect(tooltip).toBeVisible()
  await expect(tooltip.getByText('Agent trading paused', { exact: true })).toBeVisible()
  await expect(
    tooltip.getByText(`${message} Agent orders are blocked.`, { exact: true }),
  ).toBeVisible()
  await expect(tooltip.getByText('Click to retry agent checks.', { exact: true })).toBeVisible()
  const tooltipId = await tooltip.getAttribute('id')
  if (!tooltipId) throw new Error('The warning tooltip needs an accessible identity')
  await expect(warning).toHaveAttribute('aria-describedby', tooltipId)
  await page.mouse.move(0, 300)
  await expect(tooltip).toBeHidden()

  await warning.focus()
  await expect(warning).toBeFocused()
  await expect(tooltip).toBeVisible()
  await expect(
    tooltip.getByText(`${message} Agent orders are blocked.`, { exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tooltip).toBeHidden()

  const starts = await page.locator('html').getAttribute('data-synthetic-agent-risk-starts')
  await warning.click()
  await expect
    .poll(async () =>
      Number(await page.locator('html').getAttribute('data-synthetic-agent-risk-starts')),
    )
    .toBeGreaterThan(Number(starts))
  await expect(warning).toBeVisible()
  expect(writes).toEqual([])
  expect(connectionChanges).toEqual([])
})

test('ready agent risk has no paused warning or full-width notice', async ({ page }) => {
  const { writes, connectionChanges } = await interceptAgentTrading(page, { enabled: true })
  await interceptWorkstationRisk(page, { state: 'ready' })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Chart data', exact: true })).toBeEnabled()
  const toggle = page.getByRole('switch', { name: 'Agent trading', exact: true })
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('button', { name: 'Agent trading paused', exact: true })).toHaveCount(
    0,
  )
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(page.locator('.agent-risk-notice')).toHaveCount(0)
  expect(writes).toEqual([])
  expect(connectionChanges).toEqual([])
})

test('the toolbar toggles agent trading without testing or reconnecting and Connection has no permissions', async ({
  page,
}) => {
  const { writes, connectionChanges } = await interceptAgentTrading(page)
  await page.goto('/')
  const toggle = page.getByRole('switch', { name: 'Agent trading', exact: true })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).toHaveText('Agent trading')
  await page.getByRole('button', { name: 'Connection', exact: true }).click()
  const connection = page.getByRole('dialog', { name: 'Connection', exact: true })
  await expect(connection).toBeVisible()
  await expect(connection.getByRole('combobox', { name: 'Permissions', exact: true })).toHaveCount(
    0,
  )
  await expect(connection.getByText('Advanced · Agent limits', { exact: true })).toHaveCount(0)
  await connection.getByRole('button', { name: 'Close', exact: true }).last().click()

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(writes).toEqual([
    { enabled: true, generation: 'synthetic-agent-trading', expectedAgentTradingRevision: 0 },
    { enabled: false, generation: 'synthetic-agent-trading', expectedAgentTradingRevision: 1 },
  ])
  expect(connectionChanges).toEqual([])
})

for (const enabled of [false, true]) {
  test(`a failed agent trading update preserves the ${enabled ? 'enabled' : 'disabled'} switch`, async ({
    page,
  }) => {
    const { writes, connectionChanges } = await interceptAgentTrading(page, {
      enabled,
      onWrite: async (route) => {
        await route.fulfill({
          status: 409,
          json: { error: { message: 'Injected agent policy update failure' } },
        })
        return true
      },
    })
    await page.goto('/')
    const toggle = page.getByRole('switch', { name: 'Agent trading', exact: true })
    await expect(toggle).toHaveAttribute('aria-checked', String(enabled))
    await toggle.click()
    await expect(page.getByRole('alert')).toHaveText('Injected agent policy update failure')
    await expect(toggle).toHaveAttribute('aria-checked', String(enabled))
    await expect(toggle).toBeEnabled()
    expect(writes).toEqual([
      { enabled: !enabled, generation: 'synthetic-agent-trading', expectedAgentTradingRevision: 0 },
    ])
    expect(connectionChanges).toEqual([])
  })
}

test('rapid toolbar clicks serialize one agent trading update', async ({ page }) => {
  let releaseWrite: (() => void) | undefined
  const pendingWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  const { writes, connectionChanges } = await interceptAgentTrading(page, {
    onWrite: async () => {
      await pendingWrite
      return false
    },
  })
  try {
    await page.goto('/')
    const toggle = page.getByRole('switch', { name: 'Agent trading', exact: true })
    await expect(toggle).toBeEnabled()
    // Two events in one browser task also exercise the lock before React renders disabled.
    await toggle.evaluate((element) => {
      if (!(element instanceof HTMLButtonElement)) throw new Error('Expected a switch button')
      element.click()
      element.click()
    })
    await expect.poll(() => writes.length).toBe(1)
    await expect(toggle).toBeDisabled()
    expect(writes).toEqual([
      { enabled: true, generation: 'synthetic-agent-trading', expectedAgentTradingRevision: 0 },
    ])
    releaseWrite?.()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(toggle).toBeEnabled()
    expect(writes).toHaveLength(1)
    expect(connectionChanges).toEqual([])
  } finally {
    releaseWrite?.()
  }
})

test('Setup agent offers a ready Conservative preset before exposing the direct trading switch', async ({
  page,
}) => {
  const { writes, connectionChanges, snapshot } = await interceptAgentTrading(page, {
    limits: null,
  })
  await page.goto('/')
  const setup = page.getByRole('button', { name: 'Setup agent', exact: true })
  const toggle = page.getByRole('switch', { name: 'Agent trading', exact: true })
  const limits = page.getByRole('button', { name: 'Agent trading limits', exact: true })
  await expect(setup).toBeEnabled()
  await expect(toggle).toHaveCount(0)
  await expect(limits).toHaveCount(0)
  await page.locator('.topbar').screenshot({
    path: test.info().outputPath('synthetic-agent-setup-toolbar.png'),
  })
  await setup.click()
  const dialog = page.getByRole('dialog', { name: 'Agent trading limits', exact: true })
  await expect(dialog).toBeVisible()
  const save = dialog.getByRole('button', { name: 'Save and enable', exact: true })
  await expect(save).toBeEnabled()
  const presets = dialog.getByRole('radiogroup', { name: 'Limit preset', exact: true })
  await expect(presets).toBeVisible()
  await expect(presets.getByRole('radio', { name: /^Conservative/u })).toBeChecked()
  await expect(dialog.getByRole('spinbutton')).toHaveCount(8)
  await expectVisibleLimits(page, CONSERVATIVE_LIMITS)
  await expect(dialog.getByText('Advanced limits', { exact: true })).toHaveCount(0)
  expect(writes).toEqual([])
  await dialog.screenshot({ path: test.info().outputPath('synthetic-agent-setup-dialog.png') })
  await save.click()
  await expect(dialog).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toHaveText('Agent trading')
  await expect(toggle).toBeEnabled()
  await expect(limits).toBeEnabled()
  await expect(setup).toHaveCount(0)
  await page.locator('.topbar').screenshot({
    path: test.info().outputPath('synthetic-agent-configured-on-toolbar.png'),
  })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).toBeEnabled()
  await expect(dialog).toHaveCount(0)
  expect(snapshot.settings.profiles.paper.limits).toEqual(CONSERVATIVE_LIMITS)
  await page.locator('.topbar').screenshot({
    path: test.info().outputPath('synthetic-agent-configured-off-toolbar.png'),
  })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(dialog).toHaveCount(0)
  expect(snapshot.settings.profiles.paper.limits).toEqual(CONSERVATIVE_LIMITS)
  expect(writes).toEqual([
    {
      enabled: true,
      generation: 'synthetic-agent-trading',
      expectedAgentTradingRevision: 0,
      limits: CONSERVATIVE_LIMITS,
    },
    { enabled: false, generation: 'synthetic-agent-trading', expectedAgentTradingRevision: 1 },
    { enabled: true, generation: 'synthetic-agent-trading', expectedAgentTradingRevision: 2 },
  ])
  expect(connectionChanges).toEqual([])
})

test('presets fill every remaining limit without saving until confirmed', async ({ page }) => {
  const { writes, connectionChanges } = await interceptAgentTrading(page, { limits: null })
  await page.goto('/')
  await page.getByRole('button', { name: 'Setup agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent trading limits', exact: true })
  const presets = dialog.getByRole('radiogroup', { name: 'Limit preset', exact: true })
  await expect(presets).toBeVisible()
  await presets.getByRole('radio', { name: /^Normal/u }).click()
  await expect(presets.getByRole('radio', { name: /^Normal/u })).toBeChecked()
  await expectVisibleLimits(page, NORMAL_LIMITS)
  await presets.getByRole('radio', { name: /^Aggressive/u }).click()
  await expectVisibleLimits(page, AGGRESSIVE_LIMITS)
  await presets.getByRole('radio', { name: /^Conservative/u }).click()
  await expectVisibleLimits(page, CONSERVATIVE_LIMITS)
  await dialog.getByRole('spinbutton', { name: 'Maximum daily loss', exact: true }).fill('125')
  await expect(presets.getByRole('radio', { checked: true })).toHaveCount(0)
  await presets.getByRole('radio', { name: /^Normal/u }).click()
  await expectVisibleLimits(page, NORMAL_LIMITS)
  expect(writes).toEqual([])
  await dialog.screenshot({ path: test.info().outputPath('synthetic-agent-presets-normal.png') })
  await dialog.getByRole('button', { name: 'Save and enable', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toEqual([
    {
      enabled: true,
      generation: 'synthetic-agent-trading',
      expectedAgentTradingRevision: 0,
      limits: NORMAL_LIMITS,
    },
  ])
  expect(connectionChanges).toEqual([])
})

test('saved custom limits are preserved until Save explicitly removes quantity caps', async ({
  page,
}) => {
  const { writes, connectionChanges, snapshot } = await interceptAgentTrading(page)
  await page.goto('/')
  const open = page.getByRole('button', { name: 'Agent trading limits', exact: true })
  await open.click()
  const dialog = page.getByRole('dialog', { name: 'Agent trading limits', exact: true })
  const presets = dialog.getByRole('radiogroup', { name: 'Limit preset', exact: true })
  await expect(presets).toBeVisible()
  await expect(presets.getByRole('radio', { checked: true })).toHaveCount(0)
  await expect(dialog.getByRole('spinbutton')).toHaveCount(8)
  await expectVisibleLimits(page, LIMITS)
  expect(snapshot.settings.profiles.paper.limits).toEqual(LIMITS)
  expect(writes).toEqual([])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(snapshot.settings.profiles.paper.limits).toEqual(LIMITS)
  await open.click()
  await dialog.getByRole('spinbutton', { name: 'Maximum daily loss', exact: true }).fill('125')
  await expect(presets.getByRole('radio', { checked: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Save limits', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toEqual([
    {
      enabled: false,
      generation: 'synthetic-agent-trading',
      expectedAgentTradingRevision: 0,
      limits: withoutQuantityLimits({ ...LIMITS, maxDailyLoss: 125 }),
    },
  ])
  expect(connectionChanges).toEqual([])
})

test('saved limits without a connected account still require agent setup', async ({ page }) => {
  const { writes, connectionChanges } = await interceptAgentTrading(page, {
    allowedAccountIds: [],
  })
  await page.goto('/')
  const setup = page.getByRole('button', { name: 'Setup agent', exact: true })
  await expect(setup).toBeEnabled()
  await expect(page.getByRole('switch', { name: 'Agent trading', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Agent trading limits', exact: true })).toHaveCount(
    0,
  )
  await setup.click()
  const dialog = page.getByRole('dialog', { name: 'Agent trading limits', exact: true })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByText('Connect your broker in Connection settings, then return to finish setup.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    dialog.getByRole('spinbutton', { name: 'Maximum daily loss', exact: true }),
  ).toHaveValue(String(LIMITS.maxDailyLoss))
  await expect(dialog.getByRole('button', { name: 'Save and enable', exact: true })).toBeDisabled()
  await dialog.screenshot({
    path: test.info().outputPath('synthetic-agent-setup-needs-account.png'),
  })
  expect(writes).toEqual([])
  expect(connectionChanges).toEqual([])
})

test('a remotely changed agent policy invalidates open limits until reopened', async ({ page }) => {
  const { writes, connectionChanges, snapshot } = await interceptAgentTrading(page)
  await page.goto('/')
  const open = page.getByRole('button', { name: 'Agent trading limits', exact: true })
  await expect(open).toBeEnabled()
  await open.click()
  const dialog = page.getByRole('dialog', { name: 'Agent trading limits', exact: true })
  const save = dialog.getByRole('button', { name: 'Save limits', exact: true })
  await expect(save).toBeEnabled()
  const currentLimits = { ...LIMITS, maxDailyLoss: 200 }
  snapshot.settings.profiles.paper.limits = currentLimits
  snapshot.agentTradingRevision = 1
  await expect(
    page.getByRole('region', { name: 'Notifications', exact: true }).getByRole('alert'),
  ).toHaveText('The agent settings changed. Close and reopen agent trading limits.')
  await expect(save).toBeDisabled()
  expect(writes).toEqual([])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await open.click()
  await expect(
    page.getByRole('region', { name: 'Notifications', exact: true }).getByRole('alert'),
  ).toHaveCount(0)
  await expect(
    dialog.getByRole('spinbutton', { name: 'Maximum daily loss', exact: true }),
  ).toHaveValue('200')
  await save.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('switch', { name: 'Agent trading', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  expect(writes).toEqual([
    {
      enabled: false,
      generation: 'synthetic-agent-trading',
      expectedAgentTradingRevision: 1,
      limits: withoutQuantityLimits(currentLimits),
    },
  ])
  expect(connectionChanges).toEqual([])
})

test('agent trading controls remain visible within narrow terminal toolbars', async ({ page }) => {
  const { writes, connectionChanges } = await interceptAgentTrading(page)
  await page.goto('/')
  const toggle = page.getByRole('switch', { name: 'Agent trading', exact: true })
  const limits = page.getByRole('button', { name: 'Agent trading limits', exact: true })
  await expect(toggle).toBeEnabled()
  for (const width of [900, 400, 320]) {
    await page.setViewportSize({ width, height: 900 })
    const toolbar = await page.locator('.topbar').boundingBox()
    if (!toolbar) throw new Error('The terminal toolbar is absent')
    for (const control of [toggle, limits]) {
      await expect(control).toBeVisible()
      const bounds = await control.boundingBox()
      if (!bounds) throw new Error('The agent trading control is absent')
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
      expect(bounds.y).toBeGreaterThanOrEqual(toolbar.y)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(toolbar.y + toolbar.height)
    }
  }
  expect(writes).toEqual([])
  expect(connectionChanges).toEqual([])
})
