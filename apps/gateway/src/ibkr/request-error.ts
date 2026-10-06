import type { MarketDataErrorCode, TradeScriptAuthorizationFailure } from '@ibkr-terminal/contracts'

export class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly authorizationFailure?: TradeScriptAuthorizationFailure,
  ) {
    super(message)
  }
}

/** A market-data failure with a known cause; its message is written for the user. */
export class MarketDataError extends RequestError {
  constructor(
    statusCode: number,
    readonly code: MarketDataErrorCode,
    message: string,
  ) {
    super(statusCode, message)
  }
}
