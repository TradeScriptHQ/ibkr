import { afterEach, expect, it, vi } from 'vitest'
import { GatewayRequestError, gatewayRequest } from './broker-request.js'
import { createIbkrMarketDatafeed } from './market-datafeed.js'

afterEach(() => vi.unstubAllGlobals())

it('sends the same client identity and credentials for broker and datafeed requests', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  await createIbkrMarketDatafeed({ baseUrl: '/bridge' }).searchSymbols?.({ searchText: 'AAPL' })
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining('/bridge/symbols/search?'),
    expect.objectContaining({
      credentials: 'same-origin',
      headers: { 'x-tradescript-client': 'terminal-v1' },
    }),
  )
})

it('preserves a failed search as an SDK error instead of no matches', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'TWS disconnected' }), { status: 503 }),
      ),
  )
  const feed = createIbkrMarketDatafeed({ baseUrl: '/bridge' })
  await expect(feed.searchSymbols?.({ searchText: 'AAPL' })).rejects.toMatchObject({
    code: 'datafeed.request-failed',
    details: { status: 503 },
  })
})

it('preserves broker error status and message for failed mutations', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Rejected by broker' } }), { status: 409 }),
      ),
  )
  await expect(
    gatewayRequest('/bridge', '/orders', { method: 'POST', body: {} }, 'csrf', 'generation'),
  ).rejects.toEqual(new GatewayRequestError(409, '/orders', 'Rejected by broker'))
})

it('gives the chart a product explanation only for typed market-data failures', async () => {
  const message =
    "IBKR sent no chart history for AAPL while it reports that another session is using this account's live market data (IBKR 10197)."
  const respond = (body: unknown, status: number) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
    )
  const request = {
    startTime: 0,
    endTime: 1_000,
    barCount: 500,
  }
  const feed = createIbkrMarketDatafeed({ baseUrl: '/bridge' })
  const symbol = { ticker: 'AAPL', exchange: 'SMART', currency: 'USD', type: 'stock' } as const

  respond({ error: { code: 'market-data-competing-session', message, requestId: 'r1' } }, 503)
  await expect(feed.loadBars(symbol, '5m', request)).rejects.toMatchObject({
    code: 'datafeed.request-failed',
    details: { status: 503, code: 'market-data-competing-session' },
    presentation: {
      title: 'IBKR is withholding market data',
      message:
        'IBKR reports a competing live session. Restart TWS or IB Gateway and log in again; if this persists, sign out of IBKR on other devices.',
    },
  })

  const rejection =
    'IBKR rejected the chart history request for AAPL: No market data permissions (IBKR 162)'
  respond({ error: { code: 'market-data-rejected', message: rejection, requestId: 'r3' } }, 503)
  await expect(feed.loadBars(symbol, '5m', request)).rejects.toMatchObject({
    presentation: { title: 'IBKR rejected the request', message: rejection },
  })

  respond(
    { error: { code: 'internal-error', message: 'The gateway failed.', requestId: 'r2' } },
    500,
  )
  const internal = await feed.loadBars(symbol, '5m', request).catch((error: unknown) => error)
  expect(internal).toMatchObject({ code: 'datafeed.request-failed', details: { status: 500 } })
  expect((internal as { presentation?: unknown }).presentation).toBeUndefined()
})
