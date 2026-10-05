import type { MarketSymbol } from '@ibkr-terminal/contracts'

export const FORECAST_SEARCH_ROOT = 'FF'

type NativeForecastContract = MarketSymbol & {
  canonicalSymbol: string
  brokerSymbol: string
  contractIdentity: NonNullable<MarketSymbol['contractIdentity']> & {
    conId: number
    expiry: string
    right: 'C' | 'P'
    strike: number
    tradingClass: 'FF'
  }
}

/** Only explicit native dates, clocks and time zones establish an expiry instant. */
export function forecastExpiry(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2}) (\S+)$/u)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, timeZone] = match
  const expected = [year, month, day, hour, minute, second].map(Number)
  const target = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  const date = new Date(target)
  if (
    [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ].some((part, index) => part !== expected[index])
  )
    return undefined
  try {
    const format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const wallClock = (instant: number) => {
      const parts = new Map(format.formatToParts(instant).map((part) => [part.type, part.value]))
      return Date.UTC(
        Number(parts.get('year')),
        Number(parts.get('month')) - 1,
        Number(parts.get('day')),
        Number(parts.get('hour')),
        Number(parts.get('minute')),
        Number(parts.get('second')),
      )
    }
    // Observe native-zone offsets on both sides of a transition. If a clock repeats,
    // the earlier matching instant is the conservative expiration boundary.
    const candidates = [-48, -24, 0, 24, 48]
      .map((hours) => {
        const probe = target + hours * 3_600_000
        return target - (wallClock(probe) - probe)
      })
      .filter((instant) => wallClock(instant) === target)
    return candidates.length ? Math.min(...candidates) : undefined
  } catch {
    return undefined
  }
}

function isNativeForecast(row: MarketSymbol): row is NativeForecastContract {
  const identity = row.contractIdentity
  const conId = identity?.conId
  const expiresAt = forecastExpiry(identity?.expiry)
  return (
    row.type === 'event-contract' &&
    row.exchange === 'FORECASTX' &&
    row.currency === 'USD' &&
    identity?.securityType === 'OPT' &&
    identity.multiplier === 1 &&
    identity.tradingClass === FORECAST_SEARCH_ROOT &&
    typeof conId === 'number' &&
    Number.isSafeInteger(conId) &&
    conId > 0 &&
    row.canonicalSymbol === `IBKR:${conId}` &&
    row.brokerSymbol === row.canonicalSymbol &&
    (identity.right === 'C' || identity.right === 'P') &&
    typeof identity.strike === 'number' &&
    Number.isFinite(identity.strike) &&
    expiresAt !== undefined
  )
}

function sameForecastEvent(a: NativeForecastContract, b: NativeForecastContract): boolean {
  return (
    a.contractIdentity.expiry === b.contractIdentity.expiry &&
    a.contractIdentity.strike === b.contractIdentity.strike &&
    a.contractIdentity.tradingClass === b.contractIdentity.tradingClass
  )
}

function sameNativeFacts(a: MarketSymbol, b: MarketSymbol): boolean {
  return (
    a.type === b.type &&
    a.exchange === b.exchange &&
    a.currency === b.currency &&
    a.canonicalSymbol === b.canonicalSymbol &&
    a.brokerSymbol === b.brokerSymbol &&
    a.contractIdentity?.securityType === b.contractIdentity?.securityType &&
    a.contractIdentity?.conId === b.contractIdentity?.conId &&
    a.contractIdentity?.expiry === b.contractIdentity?.expiry &&
    a.contractIdentity?.strike === b.contractIdentity?.strike &&
    a.contractIdentity?.tradingClass === b.contractIdentity?.tradingClass &&
    a.contractIdentity?.multiplier === b.contractIdentity?.multiplier &&
    a.contractIdentity?.right === b.contractIdentity?.right &&
    a.contractIdentity?.localSymbol === b.contractIdentity?.localSymbol
  )
}

export function selectForecastPair(rows: readonly MarketSymbol[], asOf = Date.now()) {
  if (!Number.isFinite(asOf) || asOf < 0) throw new Error('ForecastEx reference time is invalid')
  const unique = new Map<number, MarketSymbol>()
  for (const row of rows) {
    const conId = row.contractIdentity?.conId
    if (typeof conId !== 'number' || !Number.isSafeInteger(conId) || conId <= 0) continue
    const existing = unique.get(conId)
    if (existing && !sameNativeFacts(existing, row))
      throw new Error('TWS returned conflicting ForecastEx facts for a native contract')
    if (!existing) unique.set(conId, row)
  }
  const candidates = [...unique.values()].filter(isNativeForecast).filter((row) => {
    const expiresAt = forecastExpiry(row.contractIdentity.expiry)
    return expiresAt !== undefined && expiresAt > asOf
  })
  for (const selected of candidates) {
    const event = candidates.filter((row) => sameForecastEvent(selected, row))
    if (event.length !== 2) continue
    const opposite = event.find(
      (row) => row.contractIdentity.right !== selected.contractIdentity.right,
    )
    if (opposite) return { selected, opposite }
  }
  throw new Error('TWS returned no unexpired exact ForecastEx opposing pair with unique outcomes')
}
