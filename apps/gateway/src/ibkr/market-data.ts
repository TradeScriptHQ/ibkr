import type { Contract } from '@stoqey/ib'
import { BarSizeSetting, SecType, WhatToShow } from '@stoqey/ib'
import type { MarketQuote } from './types.js'

export function marketQuoteHasPrice(quote: MarketQuote): boolean {
  if (
    [quote.last, quote.bid, quote.ask].some(
      (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
    )
  )
    return true
  // IBKR encodes an unavailable field as price -1/0 followed by size 0, so a
  // zero price paired with positive size is a valid quote, not a withdrawal.
  if (quote.bid === 0 && typeof quote.bidSize === 'number' && quote.bidSize > 0) return true
  if (quote.ask === 0 && typeof quote.askSize === 'number' && quote.askSize > 0) return true
  return false
}

export function whatToShowForContract(contract: Contract): WhatToShow {
  if (contract.secType === SecType.CRYPTO) return WhatToShow.AGGTRADES
  if (
    [SecType.CASH, SecType.CFD, SecType.CMDTY, SecType.FUND].some(
      (type) => type === contract.secType,
    )
  )
    return WhatToShow.MIDPOINT
  return WhatToShow.TRADES
}

export function toIbBarSize(interval: string): { barSize: BarSizeSetting; ms: number } {
  if (interval === '1s') return { barSize: BarSizeSetting.SECONDS_ONE, ms: 1000 }
  if (interval === '5s') return { barSize: BarSizeSetting.SECONDS_FIVE, ms: 5000 }
  if (interval === '10s') return { barSize: BarSizeSetting.SECONDS_TEN, ms: 10000 }
  if (interval === '15s') return { barSize: BarSizeSetting.SECONDS_FIFTEEN, ms: 15000 }
  if (interval === '30s') return { barSize: BarSizeSetting.SECONDS_THIRTY, ms: 30000 }
  if (interval === '1m') return { barSize: BarSizeSetting.MINUTES_ONE, ms: 60000 }
  if (interval === '2m') return { barSize: BarSizeSetting.MINUTES_TWO, ms: 120000 }
  if (interval === '3m') return { barSize: BarSizeSetting.MINUTES_THREE, ms: 180000 }
  if (interval === '5m') return { barSize: BarSizeSetting.MINUTES_FIVE, ms: 300000 }
  if (interval === '10m') return { barSize: BarSizeSetting.MINUTES_TEN, ms: 600000 }
  if (interval === '15m') return { barSize: BarSizeSetting.MINUTES_FIFTEEN, ms: 900000 }
  if (interval === '30m') return { barSize: BarSizeSetting.MINUTES_THIRTY, ms: 1800000 }
  if (interval === '1H') return { barSize: BarSizeSetting.HOURS_ONE, ms: 3600000 }
  if (interval === '2H') return { barSize: BarSizeSetting.HOURS_TWO, ms: 7200000 }
  if (interval === '4H') return { barSize: BarSizeSetting.HOURS_FOUR, ms: 14400000 }
  if (interval === '1D') return { barSize: BarSizeSetting.DAYS_ONE, ms: 86400000 }
  if (interval === '1W') return { barSize: BarSizeSetting.WEEKS_ONE, ms: 604800000 }
  if (interval === '1M') return { barSize: BarSizeSetting.MONTHS_ONE, ms: 2592000000 }
  return { barSize: BarSizeSetting.MINUTES_ONE, ms: 60000 }
}

export function toIbDurationString(durationMs: number): string {
  const seconds = Math.ceil(durationMs / 1000)
  if (seconds <= 86400) return `${Math.max(60, seconds)} S`
  const days = Math.ceil(seconds / 86400)
  if (days <= 30) return `${days} D`
  const months = Math.ceil(days / 30)
  if (months <= 12) return `${months} M`
  return `${Math.ceil(months / 12)} Y`
}

export function formatIbDateTime(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

export function parseIbBarTime(value: string): number | undefined {
  const daily = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (daily) {
    return Date.UTC(Number(daily[1]), Number(daily[2]) - 1, Number(daily[3]))
  }
  if (/^\d+$/.test(value)) {
    const numeric = Number(value)
    return numeric > 10000000000 ? numeric : numeric * 1000
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})[ -](\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (dateTime) {
    return Date.UTC(
      Number(dateTime[1]),
      Number(dateTime[2]) - 1,
      Number(dateTime[3]),
      Number(dateTime[4]),
      Number(dateTime[5]),
      Number(dateTime[6]),
    )
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
