import type { ContractDetails } from '@stoqey/ib'
import { normalizeRoutingDestination } from './contracts.js'
import type {
  BrokerOrderDuration,
  MarketSessionInfo,
  MarketSessionState,
  MarketSessionWindow,
  MarketSymbol,
} from './types.js'

export interface ParsedSchedule {
  windows: Array<{ dateKey: string; opensAt: number; closesAt: number }>
  closedKeys: Set<string>
}

export function toMarketSessionInfo(
  symbol: MarketSymbol,
  details: ContractDetails,
  asOf: number,
): MarketSessionInfo {
  const timezone = normalizeIbTimezone(details.timeZoneId)
  const trading = parseIbSchedule(details.tradingHours, timezone)
  const liquid = parseIbSchedule(details.liquidHours, timezone)
  const baseWindows = trading.windows.length > 0 ? trading.windows : liquid.windows
  const regularWindows = liquid.windows
  const derived = deriveSessionWindows(baseWindows, regularWindows)
  const currentKey = zonedDateKey(asOf, timezone)
  const closedKeys = new Set([...trading.closedKeys, ...liquid.closedKeys])
  const hasScheduleEvidence = baseWindows.length > 0 || closedKeys.size > 0
  const todayClosed = closedKeys.has(currentKey)
  const dayStart = zonedTimeToUtc(currentKey, '0000', timezone)
  const dayEnd = zonedTimeToUtc(addDays(currentKey, 1), '0000', timezone)
  const currentDayWeekend = isWeekendKey(currentKey)
  const todayRegular = regularWindows
    .filter((window) => window.dateKey === currentKey)
    .sort((a, b) => a.opensAt - b.opensAt)
  const upcoming = [
    ...(todayClosed && !currentDayWeekend
      ? [{ opensAt: dayStart, closesAt: dayEnd, state: 'holiday' as MarketSessionState }]
      : []),
    ...derived.filter(
      (window) => window.closesAt > asOf || (window.closesAt > dayStart && window.opensAt < dayEnd),
    ),
  ].sort((a, b) => a.opensAt - b.opensAt)
  const currentWindow = upcoming.find((window) => window.opensAt <= asOf && window.closesAt > asOf)
  const currentState: MarketSessionState =
    currentWindow?.state ??
    (todayClosed && !currentDayWeekend ? 'holiday' : hasScheduleEvidence ? 'closed' : 'unknown')
  const regularOpen = todayRegular[0]?.opensAt
  const regularClose = todayRegular[todayRegular.length - 1]?.closesAt
  const routingDestinations = brokerRoutingDestinations(details)
  const defaultRoutingDestination = brokerDefaultRoutingDestination(
    symbol,
    details,
    routingDestinations,
  )
  const supportsAdvancedStockControls =
    symbol.type === 'stock' && symbol.currency?.toUpperCase() === 'USD'

  return {
    symbol,
    timezone,
    currentState,
    asOf,
    upcoming,
    note:
      todayClosed && !currentDayWeekend
        ? 'Closed by IBKR schedule'
        : hasScheduleEvidence
          ? undefined
          : 'IBKR did not return a trading schedule for this contract.',
    source: 'ibkr-contract-details',
    metadata: {
      dayStart,
      dayEnd,
      regularOpen,
      regularClose,
      earlyClose:
        regularClose != null ? isEarlyRegularClose(regularClose, timezone, symbol) : undefined,
      holidayName: todayClosed && !currentDayWeekend ? 'IBKR closed' : undefined,
      tradingHours: details.tradingHours,
      liquidHours: details.liquidHours,
      timeZoneId: details.timeZoneId,
      supportedDurations: brokerSupportedDurations(details),
      minQuantity: details.minSize,
      quantityStep: details.sizeIncrement,
      contractMultiplier: details.contract.multiplier,
      routingDestinations,
      defaultRoutingDestination,
      allOrNone: supportsAdvancedStockControls
        ? { supported: true, default: false, supportedOrderTypes: ['limit'] }
        : undefined,
      oca: {
        behaviors: [
          { value: 'cancel-with-block', label: 'Cancel remaining orders with block' },
          { value: 'reduce-with-block', label: 'Reduce remaining orders with block' },
          {
            value: 'reduce-without-block',
            label: 'Reduce remaining orders without block',
          },
        ],
      },
      orderTypes: details.orderTypes,
      validExchanges: details.validExchanges,
    },
  }
}

function brokerRoutingDestinations(
  details: ContractDetails,
): NonNullable<MarketSessionInfo['metadata']>['routingDestinations'] {
  const seen = new Set<string>()
  return String(details.validExchanges ?? '')
    .split(/[;,\s]+/u)
    .map((value) => normalizeRoutingDestination(value))
    .filter((value): value is string => Boolean(value) && value !== 'OVERNIGHT')
    .filter((value) => {
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })
    .map((value) => ({ value, label: value }))
}

function brokerDefaultRoutingDestination(
  symbol: MarketSymbol,
  details: ContractDetails,
  destinations: NonNullable<MarketSessionInfo['metadata']>['routingDestinations'],
): string | undefined {
  const values = new Set(destinations?.map((destination) => destination.value))
  const requested = normalizeRoutingDestination(symbol.exchange)
  if (requested && values.has(requested)) return requested
  const qualified = normalizeRoutingDestination(details.contract?.exchange)
  if (qualified && values.has(qualified)) return qualified
  if (values.has('SMART')) return 'SMART'
  return destinations?.[0]?.value
}

function brokerSupportedDurations(details: ContractDetails): BrokerOrderDuration[] {
  const orderTypes = new Set(
    String(details.orderTypes ?? '')
      .split(/[;,\s]+/u)
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  )
  const validExchanges = new Set(
    String(details.validExchanges ?? '')
      .split(/[;,\s]+/u)
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  )
  const durations: BrokerOrderDuration[] = []
  const add = (token: string, duration: BrokerOrderDuration) => {
    if (orderTypes.has(token)) durations.push(duration)
  }

  add('DAY', { type: 'day', value: 'day', label: 'DAY', default: true })
  add('GTC', { type: 'gtc', value: 'gtc', label: 'GTC' })
  add('OPG', {
    type: 'custom',
    value: 'opg',
    label: 'OPG',
    supportedOrderTypes: ['market', 'limit'],
  })
  add('IOC', { type: 'ioc', value: 'ioc', label: 'IOC' })
  add('GTD', {
    type: 'gtd',
    value: 'gtd',
    label: 'GTD',
    hasDatePicker: true,
    hasTimePicker: true,
  })
  add('FOK', { type: 'fok', value: 'fok', label: 'FOK' })
  if (validExchanges.has('OVERNIGHT')) {
    durations.push(
      { type: 'custom', value: 'overnight-day', label: 'OVERNIGHT + DAY' },
      { type: 'custom', value: 'overnight', label: 'OVERNIGHT' },
    )
  }
  return durations.length > 0
    ? durations
    : [{ type: 'day', value: 'day', label: 'DAY', default: true }]
}

export function deriveSessionWindows(
  tradingWindows: Array<{ dateKey: string; opensAt: number; closesAt: number }>,
  liquidWindows: Array<{ opensAt: number; closesAt: number }>,
): MarketSessionWindow[] {
  if (tradingWindows.length === 0) {
    return liquidWindows.map((window) => ({
      opensAt: window.opensAt,
      closesAt: window.closesAt,
      state: 'regular',
    }))
  }
  return tradingWindows
    .flatMap((tradingWindow) => {
      const overlaps = liquidWindows
        .map((liquidWindow) => ({
          opensAt: Math.max(tradingWindow.opensAt, liquidWindow.opensAt),
          closesAt: Math.min(tradingWindow.closesAt, liquidWindow.closesAt),
        }))
        .filter((window) => window.closesAt > window.opensAt)
        .sort((a, b) => a.opensAt - b.opensAt)
      if (overlaps.length === 0) {
        return [
          {
            opensAt: tradingWindow.opensAt,
            closesAt: tradingWindow.closesAt,
            state: (liquidWindows.length === 0 ? 'unknown' : 'extended') as MarketSessionState,
          },
        ]
      }
      const windows: MarketSessionWindow[] = []
      let cursor = tradingWindow.opensAt
      for (const [index, liquidWindow] of overlaps.entries()) {
        if (liquidWindow.opensAt > cursor) {
          windows.push({
            opensAt: cursor,
            closesAt: liquidWindow.opensAt,
            state: index === 0 ? 'pre-market' : 'post-market',
          })
        }
        windows.push({
          opensAt: liquidWindow.opensAt,
          closesAt: liquidWindow.closesAt,
          state: 'regular',
        })
        cursor = Math.max(cursor, liquidWindow.closesAt)
      }
      if (cursor < tradingWindow.closesAt) {
        windows.push({
          opensAt: cursor,
          closesAt: tradingWindow.closesAt,
          state: 'post-market',
        })
      }
      return windows
    })
    .filter((window) => window.closesAt > window.opensAt)
}

export function parseIbSchedule(raw: string | undefined, timezone: string): ParsedSchedule {
  const windows: ParsedSchedule['windows'] = []
  const closedKeys = new Set<string>()
  for (const dayEntry of (raw ?? '').split(';')) {
    const separatorIndex = dayEntry.indexOf(':')
    const rawDay = separatorIndex >= 0 ? dayEntry.slice(0, separatorIndex) : dayEntry
    const rawSegments = separatorIndex >= 0 ? dayEntry.slice(separatorIndex + 1) : undefined
    const dayKey = normalizeIbDateKey(rawDay)
    const segments = rawSegments?.trim()
    if (!dayKey || !segments) continue
    if (segments.toUpperCase() === 'CLOSED') {
      closedKeys.add(dayKey)
      continue
    }
    for (const segment of segments.split(',')) {
      const [rawOpen, rawClose] = segment.split('-')
      const open = parseIbScheduleEndpoint(rawOpen, dayKey, timezone)
      const close = parseIbScheduleEndpoint(rawClose, dayKey, timezone)
      if (!open || !close || close.time <= open.time) continue
      windows.push({ dateKey: dayKey, opensAt: open.time, closesAt: close.time })
    }
  }
  return {
    windows: windows.sort((a, b) => a.opensAt - b.opensAt),
    closedKeys,
  }
}

function parseIbScheduleEndpoint(
  value: string | undefined,
  fallbackDateKey: string,
  timezone: string,
): { key: string; time: number } | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const withDate = /^(\d{8}):?(\d{4})$/.exec(trimmed)
  if (withDate?.[1] && withDate[2]) {
    const key = normalizeIbDateKey(withDate[1])
    if (!key) return undefined
    return { key, time: zonedTimeToUtc(key, withDate[2], timezone) }
  }
  if (/^\d{4}$/.test(trimmed)) {
    return { key: fallbackDateKey, time: zonedTimeToUtc(fallbackDateKey, trimmed, timezone) }
  }
  return undefined
}

export function parseIbHistoricalScheduleDateTime(
  value: string | undefined,
  fallbackTimezone: string,
): number | undefined {
  const match = value
    ?.trim()
    .match(/^(\d{4})(\d{2})(\d{2})[- ](\d{2}):(\d{2}):(\d{2})(?:\s+(.+))?$/u)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, explicitTimezone] = match
  const timezone = normalizeIbTimezone(explicitTimezone ?? fallbackTimezone)
  return zonedTimeToUtc(`${year}-${month}-${day}`, `${hour}${minute}${second}`, timezone)
}

export function normalizeIbDateKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d{8}$/.test(trimmed)) return undefined
  return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`
}

export function normalizeIbTimezone(value: string | undefined): string {
  const normalized = value?.trim()
  if (!normalized) return 'Etc/UTC'
  const mapped: Record<string, string> = {
    EST: 'America/New_York',
    EDT: 'America/New_York',
    'US/Eastern': 'America/New_York',
    'US/Central': 'America/Chicago',
    'US/Pacific': 'America/Los_Angeles',
    'GB-Eire': 'Europe/London',
    GMT: 'Etc/UTC',
    Japan: 'Asia/Tokyo',
    Hongkong: 'Asia/Hong_Kong',
    'Asia/Calcutta': 'Asia/Kolkata',
    MET: 'Europe/Berlin',
  }
  return mapped[normalized] ?? normalized
}

export function zonedTimeToUtc(key: string, hhmm: string, timezone: string): number {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  const day = Number(key.slice(8, 10))
  const hour = Number(hhmm.slice(0, 2))
  const minute = Number(hhmm.slice(2, 4))
  const second = hhmm.length >= 6 ? Number(hhmm.slice(4, 6)) : 0
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0)
  let guess = targetUtc
  for (let index = 0; index < 4; index += 1) {
    const parts = zonedParts(guess, timezone)
    const observedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    )
    const delta = targetUtc - observedUtc
    if (delta === 0) return guess
    guess += delta
  }
  return guess
}

export function zonedDateKey(ms: number, timezone: string): string {
  const parts = zonedParts(ms, timezone)
  return dateKey(parts.year, parts.month, parts.day)
}

function zonedParts(
  ms: number,
  timezone: string,
): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms))
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  return {
    year: Number(byType.get('year')),
    month: Number(byType.get('month')),
    day: Number(byType.get('day')),
    hour: Number(byType.get('hour')),
    minute: Number(byType.get('minute')),
    second: Number(byType.get('second')),
  }
}

function dateKey(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

export function addDays(key: string, days: number): string {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  const day = Number(key.slice(8, 10))
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0))
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function isWeekendKey(key: string): boolean {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  const day = Number(key.slice(8, 10))
  const weekday = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0)).getUTCDay()
  return weekday === 0 || weekday === 6
}

function isEarlyRegularClose(
  time: number,
  timezone: string,
  symbol: MarketSymbol,
): boolean | undefined {
  const listing = symbol.primaryExchange?.trim().toUpperCase()
  const knownUsEquityListing =
    symbol.type === 'stock' &&
    symbol.currency?.toUpperCase() === 'USD' &&
    timezone === 'America/New_York' &&
    (!listing || ['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS', 'IEX'].includes(listing))
  if (!knownUsEquityListing) return undefined
  const parts = zonedParts(time, timezone)
  return parts.hour < 16
}
