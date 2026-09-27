import type { MarketQuote, MarketSessionInfo, Order } from '@ibkr-terminal/contracts'
import type { APIRequestContext, Page } from '@playwright/test'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import { expect, test } from './fixtures.js'
import { assetCloseDraft } from './paper-cleanup.js'
import { cancelOrderFamily, readState, submit, verifyMarketFill } from './paper-orders.js'
import { browserHeaders, expectJsonOk } from './session.js'

export const cryptoTickers = ['BTC', 'ETH'] as const
export type CryptoTicker = (typeof cryptoTickers)[number]
export type CryptoContract = Awaited<ReturnType<typeof loadCryptoContract>>
export type CryptoMarket = CryptoContract & { quote: MarketQuote }

export async function loadCryptoContract(request: APIRequestContext, ticker: CryptoTicker) {
  const query = new URLSearchParams({
    symbol: ticker,
    exchange: 'PAXOS',
    currency: 'USD',
    assetClass: 'crypto',
  })
  const session = await expectJsonOk<MarketSessionInfo>(
    await request.get(`/api/v1/ibkr/sessions?${query}`, { headers: browserHeaders }),
  )
  expect(session.source).toBe('ibkr-contract-details')
  expect(session.symbol).toMatchObject({
    ticker,
    type: 'crypto',
    exchange: 'PAXOS',
    currency: 'USD',
  })
  const priceStep = session.symbol.minTick
  const quantityStep = session.metadata?.quantityStep
  const minQuantity = session.metadata?.minQuantity
  if (!priceStep || !quantityStep || !minQuantity)
    throw new Error('TWS did not supply crypto price and quantity increments')
  const symbol = {
    ticker,
    brokerSymbol: ticker,
    exchange: 'PAXOS',
    currency: 'USD',
    type: 'crypto' as const,
    minTick: priceStep,
  }
  return { symbol, session, priceStep, quantityStep, minQuantity }
}

export async function loadCryptoMarket(request: APIRequestContext, ticker: CryptoTicker) {
  const contract = await loadCryptoContract(request, ticker)
  const query = new URLSearchParams({
    symbol: ticker,
    exchange: 'PAXOS',
    currency: 'USD',
    assetClass: 'crypto',
  })
  let quote: MarketQuote | undefined
  await expect
    .poll(
      async () => {
        const quotes = await expectJsonOk<MarketQuote[]>(
          await request.get(`/api/v1/ibkr/quotes?fresh=true&${query}`, { headers: browserHeaders }),
        )
        quote = quotes.find(
          (entry) => entry.symbol.symbol === ticker && entry.symbol.exchange === 'PAXOS',
        )
        return Boolean(quote?.ibkrErrorCode || ((quote?.bid ?? 0) > 0 && (quote?.ask ?? 0) > 0))
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBe(true)
  if (!quote) throw new Error('TWS returned no crypto quote state')
  return { ...contract, quote }
}

export function requireCryptoTrading(
  market: CryptoMarket,
  options: { requireRealTime?: boolean } = {},
) {
  const { quote, session } = market
  // Only explicit provider restrictions skip. Missing callbacks and unexpected errors fail.
  test.skip(
    quote.status === 'unavailable' && [354, 10089, 10167].includes(quote.ibkrErrorCode ?? 0),
    `${market.symbol.ticker} PAXOS: IBKR ${quote.ibkrErrorCode}: ${quote.unavailableReason}`,
  )
  test.skip(session.currentState !== 'regular', `Crypto venue session: ${session.currentState}`)
  return currentCryptoPrices(market, options)
}

export function currentCryptoPrices(
  market: CryptoMarket,
  options: { requireRealTime?: boolean } = {},
) {
  const { quote } = market
  expect(options.requireRealTime ? ['ok'] : ['ok', 'delayed']).toContain(quote.status)
  const { bid, ask } = quote
  if (!bid || !ask || ask < bid) throw new Error('Crypto execution requires a valid broker bid/ask')
  if (options.requireRealTime) {
    expect(Date.now() - Date.parse(quote.timestamp), 'Crypto quote must be current').toBeLessThan(
      30_000,
    )
  }
  const quantity = Number(
    (
      Math.ceil(Math.max(market.minQuantity, 25 / ask) / market.quantityStep) * market.quantityStep
    ).toFixed(8),
  )
  return { bid, ask, quantity }
}

export function cryptoLimit(
  market: CryptoMarket,
  side: 'buy' | 'sell',
  quantity: number,
  price: number,
  ioc = false,
): TradingOrderDraft {
  return {
    symbol: market.symbol,
    side,
    type: 'limit',
    quantity,
    price: Number((Math.round(price / market.priceStep) * market.priceStep).toFixed(8)),
    duration: { type: ioc ? 'ioc' : 'gtc' },
  }
}

export async function expectCryptoOrder(
  request: APIRequestContext,
  id: string,
  market: CryptoMarket,
): Promise<Order> {
  const state = await readState(request)
  const order = [...state.orders, ...(state.ordersHistory ?? [])].find((entry) => entry.id === id)
  if (!order) throw new Error('Crypto order is missing from TWS readback')
  expect(order.symbol).toMatchObject({
    symbol: market.symbol.ticker,
    exchange: 'PAXOS',
    currency: 'USD',
    assetClass: 'crypto',
  })
  return order
}

/** The ledger spans entry and exit receipts; never liquidate an existing account holding. */
export async function cleanUpCryptoOrders(
  page: Page,
  request: APIRequestContext,
  ids: readonly string[],
  market: CryptoMarket,
): Promise<void> {
  for (const id of ids) await cancelOrderFamily(page, request, id, market.symbol)
  const state = await readState(request)
  const records = [...state.orders, ...(state.ordersHistory ?? [])].filter((order) =>
    ids.includes(order.id),
  )
  const close = assetCloseDraft(records, market.symbol, { type: 'ioc' }, market.quantityStep)
  if (!close) return
  if (close.side !== 'sell') throw new Error('Crypto test sold more than its own filled entries')
  const closeId = await submit(page, close)
  await verifyMarketFill(request, closeId)
}
