import { EventName, type IBApi } from '@stoqey/ib'

export type HistoricalScheduleListener = (
  requestId: number,
  start: string,
  end: string,
  timezone: string,
  sessions: Array<{ startDateTime?: string; endDateTime?: string; refDate?: string }>,
) => void

/** stoqey/ib 1.6.7 decodes this event but omits its IBApi.on overload. */
export function subscribeHistoricalSchedule(
  api: IBApi,
  listener: HistoricalScheduleListener,
): void {
  const on = api.on as unknown as (
    event: EventName.historicalSchedule,
    listener: HistoricalScheduleListener,
  ) => IBApi
  on.call(api, EventName.historicalSchedule, listener)
}
