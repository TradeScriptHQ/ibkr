import { readFileSync } from 'node:fs'
import type {
  BarHistoryResult,
  BrokerState,
  ConnectionSnapshot,
  HealthResponse,
  MarketDepth,
  MarketQuote,
  MarketSessionInfo,
  MarketSymbol,
  OptionChainContract,
  OptionChainResult,
  OptionContractResolution,
  OrderPreviewResult,
  SymbolSearchResult,
  SystemStatusResponse,
  TradeScriptBootstrapResponse,
} from '@ibkr-terminal/contracts'
import { request as playwrightRequest } from '@playwright/test'
import { WebSocket } from 'ws'
import { expect, test } from './support/fixtures.js'
import {
  browserHeaders,
  expectJsonOk,
  openTerminalSession,
  readBrokerState,
  TERMINAL_ORIGIN,
} from './support/session.js'

const installedTradeScriptVersion = (
  JSON.parse(
    readFileSync(new URL('../node_modules/@tradescript/pro/package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version

test.describe('secure local gateway and TradeScript authority', () => {
  test('rejects direct gateway access and hostile browser origins', async ({ request }) => {
    const direct = await playwrightRequest.newContext({ baseURL: 'http://127.0.0.1:3001' })
    try {
      const response = await direct.get('/api/v1/status', { headers: browserHeaders })
      expect(response.status()).toBeGreaterThanOrEqual(400)
    } finally {
      await direct.dispose()
    }

    const hostile = await request.post('/api/v1/session/bootstrap', {
      headers: {
        ...browserHeaders,
        origin: 'http://localhost:3999',
        'content-type': 'application/json',
      },
      data: {},
    })
    expect(hostile.status()).toBe(403)
    expect(await hostile.json()).toMatchObject({ error: { code: 'forbidden-origin' } })
    expect(hostile.headers()['access-control-allow-credentials']).toBeUndefined()

    const unauthenticated = await request.get('/api/v1/status', { headers: browserHeaders })
    expect(unauthenticated.status()).toBe(401)
  })

  test('boots a strict session, enforces CSRF, refreshes, and revokes it', async ({ request }) => {
    const session = await openTerminalSession(request)
    const wrongCsrf = await request.post('/api/v1/ws-tickets', {
      headers: {
        ...session.mutationHeaders,
        'x-tradescript-csrf': 'wrong-token',
      },
      data: {},
    })
    expect(wrongCsrf.status()).toBe(403)

    const refreshed = await request.post('/api/v1/session/refresh', {
      headers: session.mutationHeaders,
      data: {},
    })
    const refreshedBody = (await expectJsonOk(refreshed)) as {
      csrfToken: string
      expiresAt: string
    }
    expect(refreshedBody.csrfToken).not.toBe(session.csrfToken)

    const revoked = await request.delete('/api/v1/session', {
      headers: {
        ...session.mutationHeaders,
        'x-tradescript-csrf': refreshedBody.csrfToken,
      },
      data: {},
    })
    expect(revoked.status()).toBe(204)
    const afterRevoke = await request.get('/api/v1/status', { headers: browserHeaders })
    expect(afterRevoke.status()).toBe(401)
  })

  test('reports a complete paper-ready stack and a sanitized exact-origin lease', async ({
    request,
  }) => {
    await openTerminalSession(request)
    const [statusResponse, healthResponse, leaseResponse] = await Promise.all([
      request.get('/api/v1/status', { headers: browserHeaders }),
      request.get('/api/v1/ibkr/health', { headers: browserHeaders }),
      request.get('/api/v1/tradescript/bootstrap', { headers: browserHeaders }),
    ])
    const status = await expectJsonOk<SystemStatusResponse>(statusResponse)
    const health = await expectJsonOk<HealthResponse>(healthResponse)
    const lease = await expectJsonOk<TradeScriptBootstrapResponse>(leaseResponse)

    expect(status).toMatchObject({
      service: 'ibkr-trading-gateway',
      environment: 'paper',
      ready: true,
      tradingEnabled: true,
    })
    expect(status.requirements).toHaveLength(6)
    for (const requirement of status.requirements) {
      if (requirement.requiredForTrading)
        expect(requirement.state, requirement.message).toBe('ready')
    }
    expect(health).toMatchObject({
      ok: true,
      mode: 'paper',
      ibkrHost: '127.0.0.1',
      ibkrPort: expect.any(Number),
      liveConnectionAllowed: false,
      connectionStatus: 'connected',
    })
    expect(health.activeAccountId?.startsWith('DU')).toBe(true)
    expect([7496, 4001]).not.toContain(health.ibkrPort)

    expect(lease).toMatchObject({
      leaseType: 'TradeScript-Deployment-Lease',
      sdkVersion: installedTradeScriptVersion,
      paperTrading: { enabled: expect.any(Boolean) },
    })
    expect(lease.lease).toEqual(expect.any(String))
    expect(lease.lease.length).toBeGreaterThanOrEqual(64)
    expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now())
    expect(lease.paperTrading.allowedAccountIds.includes(health.activeAccountId ?? '')).toBe(true)
    const connection = await expectJsonOk<ConnectionSnapshot>(
      await request.get('/api/v1/connection', { headers: browserHeaders }),
    )
    const profile = connection.settings.profiles.paper
    expect(health.ibkrPort).toBe(profile.port)
    expect(lease.paperTrading.enabled).toBe(profile.permission === 'agent')
    expect(lease.paperTrading.limits).toEqual(profile.limits)
    expect(JSON.stringify(lease)).not.toMatch(/credential|secret|npm.?token/iu)
  })
})

test.describe('real TWS paper state and market-data surface', () => {
  test.beforeEach(async ({ request }) => {
    await openTerminalSession(request)
  })

  test('reconciles accounts, portfolio, orders, executions, quotes, and diagnostics', async ({
    request,
  }) => {
    const response = await request.get('/api/v1/ibkr/state', { headers: browserHeaders })
    const state = await expectJsonOk<BrokerState>(response)
    expect(state.connectionStatus).toBe('connected')
    expect(state.activeAccountId).toBeTruthy()
    expect(state.accounts).not.toHaveLength(0)
    expect(state.accounts.some((account) => account.id === state.activeAccountId)).toBe(true)
    for (const account of state.accounts) {
      expect(account.currency).toMatch(/^[A-Z]{3}$/u)
      expect(account.netLiquidation).toEqual(expect.any(Number))
      expect(account.cash).toEqual(expect.any(Number))
      expect(account.buyingPower).toEqual(expect.any(Number))
      expect(account.availableFunds).toEqual(expect.any(Number))
      expect(account.marginUsed).toEqual(expect.any(Number))
      expect(account.maintenanceMargin).toEqual(expect.any(Number))
      // PnL arrives on a separate broker stream and is optional in AccountSummary.
      // Require finite values when supplied, and retain missing values as unavailable.
      for (const field of ['dailyPnl', 'unrealizedPnl', 'realizedPnl'] as const) {
        const value = account[field]
        if (value === undefined) {
          test.info().annotations.push({
            type: 'pnl-unavailable',
            description: `TWS has not supplied ${field}`,
          })
        } else expect(Number.isFinite(value), `Broker ${field} must be finite`).toBe(true)
      }
    }
    expect(Array.isArray(state.positions)).toBe(true)
    expect(Array.isArray(state.orders)).toBe(true)
    expect(Array.isArray(state.ordersHistory)).toBe(true)
    expect(Array.isArray(state.executions)).toBe(true)
    expect(Array.isArray(state.quotes)).toBe(true)
    expect(Array.isArray(state.messages)).toBe(true)
    expect(Array.isArray(state.diagnostics)).toBe(true)
    expect(Date.parse(state.updatedAt)).toBeGreaterThan(Date.now() - 5 * 60_000)
  })

  test('searches, resolves, charts, quotes, and resolves the exchange session for AAPL', async ({
    request,
  }) => {
    const endTime = Date.now()
    const startTime = endTime - 7 * 24 * 60 * 60 * 1_000
    const [searchResponse, resolveResponse, barsResponse, quoteResponse, sessionResponse] =
      await Promise.all([
        request.get('/api/v1/ibkr/symbols/search?query=AAPL&limit=8', {
          headers: browserHeaders,
        }),
        request.get('/api/v1/ibkr/symbols/resolve?symbol=AAPL', { headers: browserHeaders }),
        request.get(
          `/api/v1/ibkr/bars?symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock&interval=5m&startTime=${startTime}&endTime=${endTime}&barCount=400`,
          { headers: browserHeaders },
        ),
        request.get(
          '/api/v1/ibkr/quotes?symbol=AAPL&exchange=SMART&currency=USD&assetClass=stock',
          {
            headers: browserHeaders,
          },
        ),
        request.get(
          '/api/v1/ibkr/sessions?symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock',
          { headers: browserHeaders },
        ),
      ])

    const search = await expectJsonOk<SymbolSearchResult[]>(searchResponse)
    const resolved = await expectJsonOk<MarketSymbol>(resolveResponse)
    const history = await expectJsonOk<BarHistoryResult>(barsResponse)
    let quotes = await expectJsonOk<MarketQuote[]>(quoteResponse)
    await expect
      .poll(
        async () => {
          const current = quotes.find((candidate) => candidate.symbol?.symbol === 'AAPL')
          if (current?.status && current.status !== 'unavailable') return true
          quotes = await expectJsonOk<MarketQuote[]>(
            await request.get(
              '/api/v1/ibkr/quotes?symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock',
              { headers: browserHeaders },
            ),
          )
          return quotes.some(
            (candidate) =>
              candidate.symbol?.symbol === 'AAPL' &&
              candidate.status &&
              candidate.status !== 'unavailable',
          )
        },
        { timeout: 35_000 },
      )
      .toBe(true)
    const session = await expectJsonOk<MarketSessionInfo>(sessionResponse)

    const searchedAapl = search.find((entry) => entry.symbol?.ticker === 'AAPL')
    expect(searchedAapl?.symbol).toMatchObject({
      ticker: 'AAPL',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      currency: 'USD',
    })
    expect(resolved).toMatchObject({
      ticker: 'AAPL',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      currency: 'USD',
    })
    expect(history.dataUnavailable).not.toBe(true)
    expect(history.bars.length).toBeGreaterThan(20)
    for (const bar of history.bars.slice(-20)) {
      expect(bar.high).toBeGreaterThanOrEqual(bar.low)
      expect(bar.open).toBeGreaterThan(0)
      expect(bar.close).toBeGreaterThan(0)
      expect(bar.time).toEqual(expect.any(Number))
    }
    expect(quotes.some((quote) => quote.symbol?.symbol === 'AAPL')).toBe(true)
    const quote = quotes.find((candidate) => candidate.symbol?.symbol === 'AAPL')
    if (!quote) throw new Error('TWS returned no AAPL quote')
    expect(['ok', 'delayed', 'stale']).toContain(quote.status)
    expect(
      [quote.last, quote.bid, quote.ask].some(
        (price) => typeof price === 'number' && Number.isFinite(price) && price > 0,
      ),
      'TWS must supply an actual price; historical bars cannot qualify a quote',
    ).toBe(true)
    expect(Number.isFinite(Date.parse(quote.timestamp))).toBe(true)
    if (quote.bid != null && quote.ask != null) {
      expect(quote.bid).toBeGreaterThan(0)
      expect(quote.ask).toBeGreaterThanOrEqual(quote.bid)
    }
    test.info().annotations.push({
      type: 'quote-status',
      description: `${quote.status}; bid/ask available: ${(quote.bid ?? 0) > 0 && (quote.ask ?? 0) > 0}`,
    })
    expect(session).toEqual(
      expect.objectContaining({
        timezone: expect.any(String),
        currentState: expect.stringMatching(/closed|pre-market|regular|post-market|holiday/u),
        upcoming: expect.any(Array),
      }),
    )
  })

  test('loads and resolves a real AAPL option chain', async ({ request }) => {
    test.setTimeout(120_000)
    const quoteResponse = await request.get(
      '/api/v1/ibkr/quotes?symbol=AAPL&exchange=SMART&currency=USD&assetClass=stock',
      { headers: browserHeaders },
    )
    const aaplQuotes = await expectJsonOk<MarketQuote[]>(quoteResponse)
    let centerPrice = aaplQuotes
      .flatMap((quote) => [quote.last, quote.bid, quote.ask, quote.previousClose])
      .find((value: unknown) => Number(value) > 0)
    if (!centerPrice) {
      const endTime = Date.now()
      const barsResponse = await request.get(
        `/api/v1/ibkr/bars?symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock&interval=5m&startTime=${endTime - 7 * 24 * 60 * 60 * 1_000}&endTime=${endTime}&barCount=400`,
        { headers: browserHeaders },
      )
      const history = await expectJsonOk<BarHistoryResult>(barsResponse)
      centerPrice = history.bars.at(-1)?.close
    }
    if (!centerPrice) throw new Error('TWS returned no option-chain reference price')
    const chainPath = `/api/v1/ibkr/options/chain?underlying=AAPL&exchange=SMART&currency=USD&centerPrice=${encodeURIComponent(centerPrice)}&quoteWindowRows=8&maxQuoteContracts=16`
    const quoteDeadline = Date.now() + 15_000
    let candidate: OptionChainContract | undefined
    while (!candidate && Date.now() < quoteDeadline) {
      const chainResponse = await request.get(chainPath, {
        headers: browserHeaders,
        timeout: 90_000,
      })
      const chain = await expectJsonOk<OptionChainResult>(chainResponse)
      expect(chain.underlying).toBe('AAPL')
      expect(chain.expirations.length).toBeGreaterThan(0)
      const contracts = chain.expirations.flatMap((expiration) => expiration.contracts)
      expect(contracts.length).toBeGreaterThan(0)
      expect(contracts.every((entry) => entry.contract?.brokerContractId)).toBe(true)
      candidate = contracts.find(
        (entry) =>
          entry.contract.brokerContractId && Date.parse(entry.contract.expiration) > Date.now(),
      )
      if (!candidate) await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!candidate) throw new Error('TWS returned no unexpired option contract')

    const state = await readBrokerState(request)
    const session = await openTerminalSession(request)
    const resolutionResponse = await request.post('/api/v1/ibkr/options/resolve', {
      headers: session.mutationHeaders,
      data: {
        expectedExecutionEnvironment: 'paper',
        accountId: state.activeAccountId,
        contract: candidate.contract,
      },
      timeout: 60_000,
    })
    const resolution = await expectJsonOk<OptionContractResolution>(resolutionResponse)
    expect(resolution.contract.underlying).toBe('AAPL')
    expect(resolution.contract.brokerContractId).toBeTruthy()
    expect(resolution.tradable).not.toBe(false)
  })

  test('reports depth and tape truthfully without synthetic rows', async ({ request }) => {
    const [depthResponse, tapeResponse] = await Promise.all([
      request.get(
        '/api/v1/ibkr/depth?symbol=AAPL&exchange=SMART&currency=USD&assetClass=stock&levels=20',
        {
          headers: browserHeaders,
        },
      ),
      request.get(
        '/api/v1/ibkr/time-and-sales?symbol=AAPL&exchange=SMART&currency=USD&assetClass=stock&limit=200',
        {
          headers: browserHeaders,
        },
      ),
    ])
    let depth = await expectJsonOk<MarketDepth>(depthResponse)
    await expect
      .poll(
        async () => {
          if (depth.bids.length || depth.asks.length || depth.diagnostic) return true
          depth = await expectJsonOk<MarketDepth>(
            await request.get(
              '/api/v1/ibkr/depth?symbol=AAPL&exchange=SMART&currency=USD&assetClass=stock&levels=20',
              { headers: browserHeaders },
            ),
          )
          return Boolean(depth.bids.length || depth.asks.length || depth.diagnostic)
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    const tape = await expectJsonOk<{ price: number; size: number }[]>(tapeResponse)
    expect(Array.isArray(depth.bids)).toBe(true)
    expect(Array.isArray(depth.asks)).toBe(true)
    expect(Array.isArray(tape)).toBe(true)
    if (depth.bids.length === 0 && depth.asks.length === 0) {
      expect(depth.diagnostic?.message, 'Missing depth must retain the broker reason').toMatch(
        /permission|subscri|not available|not supported/iu,
      )
      test.info().annotations.push({
        type: 'depth-unavailable',
        description: depth.diagnostic?.message ?? 'Missing broker depth diagnostic',
      })
    }
    if (tape.length === 0) {
      const state = await readBrokerState(request)
      const diagnostic = state.diagnostics.find(
        (item) =>
          /tick.by.tick|tickbytick/iu.test(item.text) &&
          /permission|subscri|not|unavailable/iu.test(item.text),
      )
      const calendar = await expectJsonOk<MarketSessionInfo>(
        await request.get(
          '/api/v1/ibkr/sessions?symbol=AAPL&exchange=SMART&primaryExchange=NASDAQ&currency=USD&assetClass=stock',
          { headers: browserHeaders },
        ),
      )
      expect(
        Boolean(diagnostic) || calendar.currentState !== 'regular',
        'No trades during an open session requires a broker diagnostic',
      ).toBe(true)
      test.info().annotations.push({
        type: 'tape-unavailable',
        description: diagnostic?.text ?? `Exchange session: ${calendar.currentState}`,
      })
    }
    for (const row of [...depth.bids, ...depth.asks]) {
      expect(row.price).toBeGreaterThan(0)
      expect(row.size).toBeGreaterThanOrEqual(0)
    }
    for (const print of tape) {
      expect(print.price).toBeGreaterThan(0)
      expect(print.size).toBeGreaterThan(0)
    }
  })

  test('provides event snapshots and a single-use authenticated WebSocket ticket', async ({
    request,
  }) => {
    const session = await openTerminalSession(request)
    const snapshotResponse = await request.get('/api/v1/events/snapshot', {
      headers: browserHeaders,
    })
    const snapshot = await expectJsonOk<{
      sessionGeneration: string
      cursor: number
      status: SystemStatusResponse
    }>(snapshotResponse)
    expect(snapshot.sessionGeneration).toEqual(expect.any(String))
    expect(snapshot.cursor).toEqual(expect.any(Number))
    expect(snapshot.status.ready).toBe(true)

    const ticketResponse = await request.post('/api/v1/ws-tickets', {
      headers: session.mutationHeaders,
      data: {},
    })
    const ticket = await expectJsonOk<{ ticket: string }>(ticketResponse)
    const cookie = (await request.storageState()).cookies.find(
      (candidate) => candidate.name === 'ts_terminal_session',
    )
    expect(cookie).toBeTruthy()

    const authenticate = () =>
      new Promise<{ kind: string; code?: number; snapshot?: boolean }>((resolve, reject) => {
        const socket = new WebSocket('ws://localhost:3000/api/v1/stream', {
          origin: TERMINAL_ORIGIN,
          headers: { Cookie: `${cookie?.name}=${cookie?.value}`, 'Sec-Fetch-Site': 'same-origin' },
        })
        const timer = setTimeout(() => {
          socket.terminate()
          reject(new Error('Timed out waiting for WebSocket authentication'))
        }, 10_000)
        socket.once('open', () =>
          socket.send(JSON.stringify({ type: 'authenticate', ticket: ticket.ticket })),
        )
        socket.once('message', (data) => {
          clearTimeout(timer)
          const snapshot = JSON.parse(data.toString()).type === 'snapshot'
          socket.close()
          resolve({ kind: 'message', snapshot })
        })
        socket.once('close', (code) => {
          clearTimeout(timer)
          resolve({ kind: 'closed', code })
        })
        socket.once('error', (error) => {
          clearTimeout(timer)
          socket.terminate()
          reject(error)
        })
      })
    expect(await authenticate()).toEqual({ kind: 'message', snapshot: true })
    expect(
      await authenticate(),
      'A consumed stream ticket must not authenticate a second socket',
    ).toEqual({ kind: 'closed', code: 1008 })
  })

  test('fails closed for environment drift, invalid drafts, and unapproved accounts', async ({
    request,
  }) => {
    const session = await openTerminalSession(request)
    const state = await readBrokerState(request)
    const draft = {
      accountId: state.activeAccountId,
      symbol: {
        symbol: 'AAPL',
        exchange: 'SMART',
        primaryExchange: 'NASDAQ',
        currency: 'USD',
        assetClass: 'stock',
      },
      side: 'buy',
      type: 'limit',
      duration: 'day',
      quantity: 1,
      limitPrice: 1,
      outsideRth: false,
    }

    const drift = await request.post('/api/v1/ibkr/orders/preview', {
      headers: session.mutationHeaders,
      data: { expectedExecutionEnvironment: 'live', draft, context: {} },
    })
    expect(drift.status()).toBe(409)

    const invalid = await request.post('/api/v1/ibkr/orders/preview', {
      headers: session.mutationHeaders,
      data: {
        expectedExecutionEnvironment: 'paper',
        draft: { ...draft, quantity: 0 },
        context: { accountId: state.activeAccountId },
      },
    })
    const invalidBody = await expectJsonOk<OrderPreviewResult>(invalid)
    expect(invalidBody).toMatchObject({ accepted: false })

    for (const assetClass of ['futures', 'bond', 'fund', 'index', 'cfd', 'warrant', 'commodity']) {
      const unsupported = await request.get(
        `/api/v1/ibkr/sessions?symbol=TEST&assetClass=${assetClass}&exchange=SMART&currency=USD`,
        { headers: browserHeaders },
      )
      expect(unsupported.status()).toBe(400)
      const preview = await expectJsonOk<OrderPreviewResult>(
        await request.post('/api/v1/ibkr/orders/preview', {
          headers: session.mutationHeaders,
          data: {
            expectedExecutionEnvironment: 'paper',
            draft: { ...draft, symbol: { ...draft.symbol, assetClass } },
            context: { accountId: state.activeAccountId },
          },
        }),
      )
      expect(preview.accepted).toBe(false)
      expect(preview.reason).toMatch(
        assetClass === 'index'
          ? /reference data/
          : assetClass === 'fund'
            ? /mutual fund trading in paper accounts/
            : /exact IBKR.*contract/,
      )
    }

    const unapproved = await request.post('/api/v1/ibkr/orders/preview', {
      headers: session.mutationHeaders,
      data: {
        expectedExecutionEnvironment: 'paper',
        draft: { ...draft, accountId: 'NOT-AN-ALLOWED-ACCOUNT' },
        context: { accountId: 'NOT-AN-ALLOWED-ACCOUNT' },
      },
    })
    const unapprovedBody = await expectJsonOk<OrderPreviewResult>(unapproved)
    expect(unapprovedBody.accepted).toBe(false)
    expect(unapprovedBody.reason).toMatch(/allow|account/iu)
  })
})
