import type { TradeScriptAuthorizationFailure } from '@ibkr-terminal/contracts'

export class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly authorizationFailure?: TradeScriptAuthorizationFailure,
  ) {
    super(message)
  }
}
