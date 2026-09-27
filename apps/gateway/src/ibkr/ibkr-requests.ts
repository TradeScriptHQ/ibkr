import {
  BarSizeSetting,
  type Contract,
  type ContractDescription,
  type ContractDetails,
  EventName,
  type IBApi,
  type PriceIncrement,
  type SecType,
  WhatToShow,
} from '@stoqey/ib'
import { subscribeHistoricalSchedule } from './historical-schedule-event.js'
import {
  formatIbDateTime,
  parseIbBarTime,
  toIbDurationString,
  whatToShowForContract,
} from './market-data.js'
import type { IbSecDefOptionParameters } from './option-chain.js'
import { RequestError } from './request-error.js'
import {
  addDays,
  normalizeIbDateKey,
  normalizeIbTimezone,
  type ParsedSchedule,
  parseIbHistoricalScheduleDateTime,
  zonedDateKey,
  zonedTimeToUtc,
} from './session-calendar.js'
import type { MarketBar } from './types.js'

const CONTRACT_DETAILS_TIMEOUT_MS = 12000
const OPTION_CHAIN_TIMEOUT_MS = 12000
const SYMBOL_SEARCH_TIMEOUT_MS = 3000
const MARKET_RULE_TIMEOUT_MS = 5000
const SMALL_BAR_GLOBAL_WINDOW_MS = 10 * 60_000
const SMALL_BAR_GLOBAL_LIMIT = 60
const SMALL_BAR_IDENTICAL_WINDOW_MS = 15_000
const SMALL_BAR_BURST_WINDOW_MS = 2_000
const SMALL_BAR_BURST_LIMIT = 5

/** Owns request IDs and the callback lifetime of finite IBKR queries. */
export class IbkrRequests {
  private nextRequestId = 9200
  private readonly marketRuleCache = new Map<number, Promise<PriceIncrement[]>>()
  private readonly smallBarRequests: Array<{
    at: number
    signature: string
    contractKey: string
  }> = []
  constructor(
    private readonly ib: IBApi,
    private readonly isConnected: () => boolean,
  ) {}
  allocateRequestId(): number {
    this.nextRequestId += 1
    return this.nextRequestId
  }

  requestContractDetails(
    contract: Contract,
    timeoutMs = CONTRACT_DETAILS_TIMEOUT_MS,
  ): Promise<ContractDetails[]> {
    if (!this.isConnected()) {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    const reqId = this.allocateRequestId()
    const details: ContractDetails[] = []
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(
          new RequestError(504, `Timed out resolving ${contract.symbol ?? 'symbol'} from IBKR`),
        )
      }, timeoutMs)
      const onDetails = (eventReqId: number, contractDetails: ContractDetails) => {
        if (eventReqId === reqId) details.push(contractDetails)
      }
      const onBondDetails = (eventReqId: number, payload: unknown) => {
        if (isBondContractDetails(payload)) onDetails(eventReqId, payload)
      }
      const onEnd = (eventReqId: number) => {
        if (eventReqId !== reqId) return
        cleanup()
        resolve(details)
      }
      const onError = (error: Error, code?: number, eventReqId?: number) => {
        if (eventReqId !== reqId) return
        // Contract-detail currency-factor warnings do not terminate the response stream.
        if (code === 2130) return
        cleanup()
        const suffix = code ? ` (${code} req ${reqId})` : ''
        reject(new RequestError(404, `${error.message}${suffix}`))
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.ib.off(EventName.contractDetails, onDetails)
        this.ib.off(EventName.bondContractDetails, onBondDetails)
        this.ib.off(EventName.contractDetailsEnd, onEnd)
        this.ib.off(EventName.error, onError)
      }
      this.ib.on(EventName.contractDetails, onDetails)
      // stoqey/ib 1.6.7's decoder emits ContractDetails; its overload incorrectly says Contract.
      this.ib.on(EventName.bondContractDetails, onBondDetails)
      this.ib.on(EventName.contractDetailsEnd, onEnd)
      this.ib.on(EventName.error, onError)
      this.ib.reqContractDetails(reqId, contract)
    })
  }

  requestSecDefOptParams(
    underlyingSymbol: string,
    exchange: string,
    underlyingSecType: SecType,
    underlyingConId: number,
    timeoutMs = OPTION_CHAIN_TIMEOUT_MS,
  ): Promise<IbSecDefOptionParameters[]> {
    if (!this.isConnected()) {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    const reqId = this.allocateRequestId()
    const parameters: IbSecDefOptionParameters[] = []
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(
          new RequestError(504, `Timed out loading option chain for ${underlyingSymbol} from IBKR`),
        )
      }, timeoutMs)
      const onParameters = (
        eventReqId: number,
        eventExchange: string,
        underlyingConIdValue: number,
        tradingClass: string,
        multiplier: string,
        expirations: string[],
        strikes: number[],
      ) => {
        if (eventReqId !== reqId) return
        parameters.push({
          exchange: eventExchange,
          underlyingConId: underlyingConIdValue,
          tradingClass,
          multiplier,
          expirations,
          strikes,
        })
      }
      const onEnd = (eventReqId: number) => {
        if (eventReqId !== reqId) return
        cleanup()
        resolve(parameters)
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.ib.off(EventName.securityDefinitionOptionParameter, onParameters)
        this.ib.off(EventName.securityDefinitionOptionParameterEnd, onEnd)
      }
      this.ib.on(EventName.securityDefinitionOptionParameter, onParameters)
      this.ib.on(EventName.securityDefinitionOptionParameterEnd, onEnd)
      this.ib.reqSecDefOptParams(
        reqId,
        underlyingSymbol,
        exchange,
        underlyingSecType,
        underlyingConId,
      )
    })
  }

  requestMatchingSymbols(
    pattern: string,
    timeoutMs = SYMBOL_SEARCH_TIMEOUT_MS,
  ): Promise<ContractDescription[]> {
    if (!this.isConnected()) {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    const reqId = this.allocateRequestId()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new RequestError(504, `Timed out searching ${pattern} from IBKR`))
      }, timeoutMs)
      const onSamples = (eventReqId: number, descriptions: ContractDescription[]) => {
        if (eventReqId !== reqId) return
        cleanup()
        resolve(descriptions)
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.ib.off(EventName.symbolSamples, onSamples)
      }
      this.ib.on(EventName.symbolSamples, onSamples)
      this.ib.reqMatchingSymbols(reqId, pattern)
    })
  }

  requestMarketRule(
    marketRuleId: number,
    timeoutMs = MARKET_RULE_TIMEOUT_MS,
  ): Promise<PriceIncrement[]> {
    if (!this.isConnected()) {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    if (!Number.isSafeInteger(marketRuleId) || marketRuleId <= 0) {
      throw new RequestError(400, 'A valid IBKR market rule ID is required')
    }
    const cached = this.marketRuleCache.get(marketRuleId)
    if (cached) return cached
    const pending = new Promise<PriceIncrement[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new RequestError(504, `Timed out loading IBKR market rule ${marketRuleId}`))
      }, timeoutMs)
      const onMarketRule = (eventMarketRuleId: number, values: unknown[]) => {
        if (eventMarketRuleId !== marketRuleId) return
        cleanup()
        const increments = values
          .filter(isPriceIncrement)
          .sort((left, right) => left.lowEdge - right.lowEdge)
        if (!increments.length) {
          reject(new RequestError(502, `IBKR market rule ${marketRuleId} returned no increments`))
          return
        }
        resolve(increments)
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.ib.off(EventName.marketRule, onMarketRule)
      }
      this.ib.on(EventName.marketRule, onMarketRule)
      this.ib.reqMarketRule(marketRuleId)
    }).catch((error) => {
      if (this.marketRuleCache.get(marketRuleId) === pending) {
        this.marketRuleCache.delete(marketRuleId)
      }
      throw error
    })
    this.marketRuleCache.set(marketRuleId, pending)
    return pending
  }

  requestHistoricalBars(
    contract: Contract,
    request: { endDateTime: string; duration: string; barSize: BarSizeSetting },
  ): Promise<MarketBar[]> {
    if (!this.isConnected()) {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    this.assertHistoricalPacing(contract, request)
    const reqId = this.allocateRequestId()
    const bars: MarketBar[] = []
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ib.cancelHistoricalData(reqId)
        cleanup()
        reject(
          new RequestError(
            504,
            `Timed out loading historical bars for ${contract.symbol ?? 'symbol'} from IBKR`,
          ),
        )
      }, 20000)
      const onHistoricalData = (
        eventReqId: number,
        time: string,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number,
      ) => {
        if (eventReqId !== reqId) return
        if (time.startsWith('finished')) {
          cleanup()
          resolve(bars.sort((a, b) => a.time - b.time))
          return
        }
        const parsedTime = parseIbBarTime(time)
        if (parsedTime == null) return
        bars.push({
          time: parsedTime,
          open,
          high,
          low,
          close,
          ...(Number.isFinite(volume) && volume >= 0 ? { volume } : {}),
        })
      }
      const onError = (error: Error, code?: number, eventReqId?: number) => {
        if (eventReqId !== reqId) return
        this.ib.cancelHistoricalData(reqId)
        cleanup()
        const suffix = code ? ` (${code})` : ''
        reject(new RequestError(historicalErrorStatus(error, code), `${error.message}${suffix}`))
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.ib.off(EventName.historicalData, onHistoricalData)
        this.ib.off(EventName.error, onError)
      }
      this.ib.on(EventName.historicalData, onHistoricalData)
      this.ib.on(EventName.error, onError)
      this.ib.reqHistoricalData(
        reqId,
        contract,
        request.endDateTime,
        request.duration,
        request.barSize,
        whatToShowForContract(contract),
        0,
        2,
        false,
      )
    })
  }

  requestHistoricalSchedule(
    contract: Contract,
    startTime: number,
    endTime: number,
    useRegularTradingHours: boolean,
  ): Promise<{
    startTime: number
    endTime: number
    timezone: string
    windows: ParsedSchedule['windows']
  }> {
    if (!this.isConnected()) {
      throw new RequestError(503, 'IBKR bridge is not connected')
    }
    const reqId = this.allocateRequestId()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ib.cancelHistoricalData(reqId)
        cleanup()
        reject(
          new RequestError(
            504,
            `Timed out loading the session calendar for ${contract.symbol ?? 'symbol'} from IBKR`,
          ),
        )
      }, 20000)
      const onHistoricalSchedule = (
        eventReqId: number,
        rawStartTime: string,
        rawEndTime: string,
        rawTimezone: string,
        sessions: Array<{ startDateTime?: string; endDateTime?: string; refDate?: string }>,
      ) => {
        if (eventReqId !== reqId) return
        cleanup()
        const timezone = normalizeIbTimezone(rawTimezone)
        const resolvedStartTime = parseIbHistoricalScheduleDateTime(rawStartTime, timezone)
        const resolvedEndTime = parseIbHistoricalScheduleDateTime(rawEndTime, timezone)
        if (
          resolvedStartTime === undefined ||
          resolvedEndTime === undefined ||
          resolvedEndTime <= resolvedStartTime
        ) {
          reject(new RequestError(502, 'IBKR returned invalid session-calendar coverage'))
          return
        }
        const windows = sessions
          .flatMap((session) => {
            const opensAt = parseIbHistoricalScheduleDateTime(session.startDateTime ?? '', timezone)
            const closesAt = parseIbHistoricalScheduleDateTime(session.endDateTime ?? '', timezone)
            const dateKey = normalizeIbDateKey(session.refDate)
            return opensAt === undefined || closesAt === undefined || closesAt <= opensAt
              ? []
              : [{ dateKey: dateKey ?? zonedDateKey(opensAt, timezone), opensAt, closesAt }]
          })
          .sort((left, right) => left.opensAt - right.opensAt)
        const referenceDateKeys = sessions
          .map((session) => normalizeIbDateKey(session.refDate))
          .filter((key): key is string => key !== undefined)
          .sort()
        const firstReferenceDate = referenceDateKeys[0]
        const lastReferenceDate = referenceDateKeys.at(-1)
        const calendarStartTime = firstReferenceDate
          ? zonedTimeToUtc(firstReferenceDate, '0000', timezone)
          : resolvedStartTime
        const calendarEndTime = lastReferenceDate
          ? zonedTimeToUtc(addDays(lastReferenceDate, 1), '0000', timezone)
          : resolvedEndTime
        resolve({
          startTime: Math.min(resolvedStartTime, calendarStartTime),
          endTime: Math.max(resolvedEndTime, calendarEndTime),
          timezone,
          windows,
        })
      }
      const onError = (error: Error, code?: number, eventReqId?: number) => {
        if (eventReqId !== reqId) return
        this.ib.cancelHistoricalData(reqId)
        cleanup()
        const suffix = code ? ` (${code})` : ''
        reject(new RequestError(historicalErrorStatus(error, code), `${error.message}${suffix}`))
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.ib.off(EventName.historicalSchedule, onHistoricalSchedule)
        this.ib.off(EventName.error, onError)
      }
      subscribeHistoricalSchedule(this.ib, onHistoricalSchedule)
      this.ib.on(EventName.error, onError)
      this.ib.reqHistoricalData(
        reqId,
        contract,
        formatIbDateTime(endTime),
        toIbDurationString(Math.max(endTime - startTime, 24 * 60 * 60 * 1000)),
        BarSizeSetting.DAYS_ONE,
        WhatToShow.SCHEDULE,
        useRegularTradingHours,
        2,
        false,
      )
    })
  }

  private assertHistoricalPacing(
    contract: Contract,
    request: { endDateTime: string; duration: string; barSize: BarSizeSetting },
  ): void {
    if (!isSmallHistoricalBar(request.barSize)) return
    const now = Date.now()
    while (
      this.smallBarRequests[0] &&
      this.smallBarRequests[0].at <= now - SMALL_BAR_GLOBAL_WINDOW_MS
    ) {
      this.smallBarRequests.shift()
    }
    const contractKey = historicalContractKey(contract)
    const signature = JSON.stringify({ contractKey, ...request })
    const identical = this.smallBarRequests.find(
      (entry) => entry.signature === signature && entry.at > now - SMALL_BAR_IDENTICAL_WINDOW_MS,
    )
    if (identical) {
      const retryMs = SMALL_BAR_IDENTICAL_WINDOW_MS - (now - identical.at)
      throw new RequestError(
        429,
        `IBKR historical pacing: an identical small-bar request must wait ${Math.ceil(retryMs / 1000)} seconds.`,
      )
    }
    const burstCount = this.smallBarRequests.filter(
      (entry) => entry.contractKey === contractKey && entry.at > now - SMALL_BAR_BURST_WINDOW_MS,
    ).length
    if (burstCount >= SMALL_BAR_BURST_LIMIT) {
      throw new RequestError(
        429,
        'IBKR historical pacing: no more than five small-bar requests for one contract may start within two seconds.',
      )
    }
    if (this.smallBarRequests.length >= SMALL_BAR_GLOBAL_LIMIT) {
      const oldest = this.smallBarRequests[0]
      if (!oldest) return
      const retryMs = SMALL_BAR_GLOBAL_WINDOW_MS - (now - oldest.at)
      throw new RequestError(
        429,
        `IBKR historical pacing: the shared 60-request small-bar budget is exhausted; retry in ${Math.ceil(retryMs / 1000)} seconds.`,
      )
    }
    this.smallBarRequests.push({ at: now, signature, contractKey })
  }
}

function isSmallHistoricalBar(barSize: BarSizeSetting): boolean {
  return /^(?:1|5|10|15|30) secs$/u.test(String(barSize))
}

function historicalContractKey(contract: Contract): string {
  return JSON.stringify({
    conId: contract.conId,
    symbol: contract.symbol,
    secType: contract.secType,
    exchange: contract.exchange,
    primaryExch: contract.primaryExch,
    currency: contract.currency,
    lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth,
  })
}

function historicalErrorStatus(error: Error, code?: number): number {
  return code === 162 && /pacing|rate limit|too many/i.test(error.message) ? 429 : 503
}

function isPriceIncrement(value: unknown): value is PriceIncrement {
  return (
    typeof value === 'object' &&
    value !== null &&
    'lowEdge' in value &&
    'increment' in value &&
    typeof value.lowEdge === 'number' &&
    Number.isFinite(value.lowEdge) &&
    value.lowEdge >= 0 &&
    typeof value.increment === 'number' &&
    Number.isFinite(value.increment) &&
    value.increment > 0
  )
}

function isBondContractDetails(value: unknown): value is ContractDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    'contract' in value &&
    typeof value.contract === 'object' &&
    value.contract !== null &&
    'secType' in value.contract &&
    value.contract.secType === 'BOND'
  )
}
