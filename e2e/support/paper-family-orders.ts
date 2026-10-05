import type {
  BrokerSymbol,
  MarketQuote,
  OrderDraft,
  OrderPreviewResult,
  PlaceOrderResult,
} from '@ibkr-terminal/contracts'
import type { APIRequestContext } from '@playwright/test'
import { browserHeaders, expectJsonOk, type TerminalSession } from './session.js'

const MAX_QUOTE_AGE_MS = 30_000
const nativeFamily = { bond: 'BOND', warrant: 'WAR', commodity: 'CMDTY', cfd: 'CFD' }

export function exactLiveFamilyQuote(
  symbol: BrokerSymbol,
  quotes: readonly MarketQuote[],
  now = Date.now(),
): MarketQuote {
  const fail = (reason: string): never => {
    throw new Error(`Paper market precondition failed: ${reason}`)
  }
  const identity = symbol.contractIdentity
  if (!identity) return fail('missing or contradictory exact native contract facts')
  if (
    !Number.isSafeInteger(identity.conId) ||
    Number(identity.conId) <= 0 ||
    !symbol.assetClass ||
    !Object.hasOwn(nativeFamily, symbol.assetClass) ||
    nativeFamily[symbol.assetClass as keyof typeof nativeFamily] !== identity.securityType ||
    symbol.symbol !== `IBKR:${identity.conId}` ||
    symbol.canonicalSymbol !== symbol.symbol ||
    !symbol.currency ||
    !symbol.exchange
  )
    fail('missing or contradictory exact native contract facts')
  const matches = quotes.filter((quote) => {
    const received = quote.symbol
    return (
      (received.symbol === symbol.symbol ||
        (received.canonicalSymbol === symbol.symbol &&
          received.contractIdentity?.conId === identity.conId)) &&
      (received.contractIdentity?.conId === undefined ||
        received.contractIdentity.conId === identity.conId) &&
      (received.contractIdentity?.securityType === undefined ||
        received.contractIdentity.securityType === identity.securityType) &&
      received.assetClass === symbol.assetClass &&
      received.currency === symbol.currency &&
      received.exchange === symbol.exchange &&
      (received.canonicalSymbol === undefined ||
        received.canonicalSymbol === symbol.canonicalSymbol)
    )
  })
  if (matches.length !== 1) fail('quote does not identify one exact native contract')
  const quote = matches[0]!
  if (quote.ibkrErrorCode !== undefined) fail(`IBKR quote error ${quote.ibkrErrorCode}`)
  if (quote.status !== 'ok' || quote.marketDataType !== 'live')
    fail('IBKR has not supplied live quote status')
  for (const key of [
    'localSymbol',
    'expiry',
    'strike',
    'right',
    'tradingClass',
    'multiplier',
  ] as const)
    if (
      identity[key] !== undefined &&
      quote.symbol.contractIdentity?.[key] !== undefined &&
      identity[key] !== quote.symbol.contractIdentity[key]
    )
      fail('quote contradicts retained native contract terms')
  if (
    !Number.isFinite(quote.bid) ||
    !Number.isFinite(quote.ask) ||
    Number(quote.bid) <= 0 ||
    Number(quote.ask) <= 0 ||
    Number(quote.ask) < Number(quote.bid)
  )
    fail('a positive uncrossed broker bid and ask are required')
  for (const value of [quote.timestamp, quote.bidUpdatedAt, quote.askUpdatedAt]) {
    const time = value === undefined ? Number.NaN : Date.parse(value)
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(time) ||
      time > now ||
      now - time >= MAX_QUOTE_AGE_MS
    )
      fail('fresh quote, bid and ask observation times are required')
  }
  return quote
}

async function requireLiveFamilyQuote(request: APIRequestContext, symbol: BrokerSymbol) {
  const deadline = Date.now() + 45_000
  const params = new URLSearchParams({
    symbol: symbol.symbol,
    exchange: symbol.exchange ?? '',
    currency: symbol.currency ?? '',
    assetClass: symbol.assetClass ?? '',
    fresh: 'true',
  })
  while (Date.now() < deadline) {
    const quotes = await expectJsonOk<MarketQuote[]>(
      await request.get(`/api/v1/ibkr/quotes?${params}`, {
        headers: browserHeaders,
        timeout: Math.max(1, deadline - Date.now()),
      }),
    )
    // Only the broker's initial empty subscription state waits for callbacks.
    // Explicit errors, wrong identity, stale prices and delayed/frozen facts fail.
    if (
      quotes.length === 1 &&
      quotes[0]?.status === 'unavailable' &&
      quotes[0].ibkrErrorCode === undefined &&
      quotes[0].bid === undefined &&
      quotes[0].ask === undefined
    ) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())))
      continue
    }
    return exactLiveFamilyQuote(symbol, quotes)
  }
  throw new Error(
    'Paper market precondition failed: IBKR supplied no fresh exact bid/ask within 45s',
  )
}

export async function placeFamilyOrder(
  request: APIRequestContext,
  session: TerminalSession,
  draft: OrderDraft,
): Promise<string> {
  await requireLiveFamilyQuote(request, draft.symbol)
  const body = { draft, expectedExecutionEnvironment: 'paper' }
  const preview = await expectJsonOk<OrderPreviewResult>(
    await request.post('/api/v1/ibkr/orders/preview', {
      headers: session.mutationHeaders,
      data: body,
    }),
  )
  if (!preview.accepted) throw new Error(preview.reason ?? 'Broker rejected preview')
  await requireLiveFamilyQuote(request, draft.symbol)
  const result = await expectJsonOk<PlaceOrderResult>(
    await request.post('/api/v1/ibkr/orders', {
      headers: session.mutationHeaders,
      data: { ...body, draft: { ...draft, confirmId: preview.confirmId } },
    }),
  )
  if (!result.order?.id) throw new Error('Missing test-owned order receipt')
  return result.order.id
}
