import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MarketSymbol } from '@ibkr-terminal/contracts'
import { FORECAST_SEARCH_ROOT, forecastExpiry, selectForecastPair } from './forecast-contracts.js'

function outcome(
  conId: number,
  right: 'C' | 'P',
  expiry: string,
): MarketSymbol & { contractIdentity: NonNullable<MarketSymbol['contractIdentity']> } {
  return {
    ticker: `SYNTHETIC_FF_${conId}`,
    brokerSymbol: `IBKR:${conId}`,
    canonicalSymbol: `IBKR:${conId}`,
    exchange: 'FORECASTX',
    currency: 'USD',
    type: 'event-contract',
    contractIdentity: {
      securityType: 'OPT',
      conId,
      expiry,
      tradingClass: 'FF',
      multiplier: 1,
      strike: 3.125,
      right,
    },
  }
}

const nativeExpiry = '20261028 13:00:00 US/Central'
const yes = outcome(41, 'C', nativeExpiry)
const no = outcome(42, 'P', nativeExpiry)
const future = [yes, no]

test('ForecastEx root discovery selects a future native pair without deriving a current month', () => {
  assert.equal(FORECAST_SEARCH_ROOT, 'FF')
  const stale = [
    outcome(31, 'C', '20260929 13:00:00 US/Central'),
    outcome(32, 'P', '20260929 13:00:00 US/Central'),
  ]
  const pair = selectForecastPair([...stale, ...future], Date.parse('2026-09-30T12:00:00Z'))
  assert.strictEqual(pair.selected, future[0])
  assert.strictEqual(pair.opposite, future[1])
})

test('native expiration is honored within its date and at the exact provider clock boundary', () => {
  const expiry = Date.parse('2026-10-28T18:00:00Z')
  assert.equal(forecastExpiry(nativeExpiry), expiry)
  assert.equal(selectForecastPair(future, expiry - 1).selected.contractIdentity.conId, 41)
  assert.throws(() => selectForecastPair(future, expiry), /no unexpired exact ForecastEx/)
  assert.throws(() => selectForecastPair(future, expiry + 1), /no unexpired exact ForecastEx/)
  assert.equal(forecastExpiry('20261105 13:00:00 US/Central'), Date.parse('2026-11-05T19:00:00Z'))
})

test('repeated native clocks use the earlier expiry and nonexistent clocks are unavailable', () => {
  assert.equal(forecastExpiry('20261101 01:30:00 US/Central'), Date.parse('2026-11-01T06:30:00Z'))
  assert.equal(forecastExpiry('20260308 02:30:00 US/Central'), undefined)
})

test('missing, malformed and timezone-free expiry facts cannot establish an unexpired contract', () => {
  for (const expiry of [
    undefined,
    '202610',
    '20261028',
    '20261028 13:00:00',
    '20260230 13:00:00 US/Central',
    '20261028 24:00:00 US/Central',
    '20261028 13:00:00 Not/AZone',
  ]) {
    assert.equal(forecastExpiry(expiry), undefined)
  }
  assert.throws(() => selectForecastPair(future, Number.NaN), /reference time is invalid/)
})

test('pairing requires the exact native expiry, strike, class and opposite right', () => {
  for (const identity of [
    { ...no.contractIdentity, expiry: '20261105 13:00:00 US/Central' },
    { ...no.contractIdentity, strike: 3.25 },
    { ...no.contractIdentity, tradingClass: 'OTHER' },
    { ...no.contractIdentity, right: 'C' },
    { ...no.contractIdentity, multiplier: 100 },
    { ...no.contractIdentity, securityType: 'FOP' },
  ]) {
    assert.throws(
      () =>
        selectForecastPair(
          [yes, { ...no, contractIdentity: identity }],
          Date.parse('2026-09-30T12:00:00Z'),
        ),
      /no unexpired exact ForecastEx/,
    )
  }
})

test('native IDs, venue and currency are validated without constructing replacement identities', () => {
  const forgedRows: MarketSymbol[] = [
    { ...no, canonicalSymbol: 'IBKR:43' },
    { ...no, brokerSymbol: 'IBKR:43' },
    { ...no, exchange: 'SMART' },
    { ...no, currency: 'EUR' },
    { ...no, type: 'option' },
    { ...no, contractIdentity: { ...no.contractIdentity, conId: 0 } },
  ]
  for (const forged of forgedRows) {
    assert.throws(
      () => selectForecastPair([yes, forged], Date.parse('2026-09-30T12:00:00Z')),
      /no unexpired exact ForecastEx/,
    )
  }
})

test('ambiguous native outcomes are rejected and only agreeing exact-ID duplicates are deduplicated', () => {
  const now = Date.parse('2026-09-30T12:00:00Z')
  for (const additional of [outcome(43, 'C', nativeExpiry), outcome(44, 'P', nativeExpiry)]) {
    assert.throws(() => selectForecastPair([...future, additional], now), /unique outcomes/)
  }
  const pair = selectForecastPair(
    [...future, { ...yes, contractIdentity: { ...yes.contractIdentity } }, { ...no }],
    now,
  )
  assert.strictEqual(pair.selected, yes)
  assert.strictEqual(pair.opposite, no)
  for (const conflict of [
    { ...no, contractIdentity: { ...no.contractIdentity, strike: 3.25 } },
    { ...no, contractIdentity: { ...no.contractIdentity, tradingClass: 'OTHER' } },
    { ...no, contractIdentity: { ...no.contractIdentity, multiplier: 100 } },
    { ...no, exchange: 'SMART' },
  ])
    assert.throws(
      () => selectForecastPair([...future, conflict], now),
      /conflicting ForecastEx facts/,
    )
})
