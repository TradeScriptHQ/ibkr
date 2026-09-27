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
