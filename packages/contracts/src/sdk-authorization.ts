/** Public deployment-lease errors from chart-authorization. */
export const tradeScriptAuthorizationErrorCodes = [
  'unauthorized',
  'trial_access_expired',
  'subscription_access_expired',
  'subscription_inactive',
  'account_closed',
  'client_suspended',
  'origin_not_authorized',
  'deployment_not_authorized',
  'sdk_version_not_authorized',
  'sdk_build_not_authorized',
  'invalid_request',
  'not_found',
  'method_not_allowed',
  'authorization_changed',
  'authorization_unavailable',
  'internal_error',
] as const

export type TradeScriptAuthorizationErrorCode = (typeof tradeScriptAuthorizationErrorCodes)[number]

export const tradeScriptAuthorizationErrorStatus: Record<
  TradeScriptAuthorizationErrorCode,
  readonly number[]
> = {
  unauthorized: [401],
  trial_access_expired: [403],
  subscription_access_expired: [403],
  subscription_inactive: [403],
  account_closed: [403],
  client_suspended: [403],
  origin_not_authorized: [403],
  deployment_not_authorized: [403],
  sdk_version_not_authorized: [403],
  sdk_build_not_authorized: [403],
  invalid_request: [400, 413, 415],
  not_found: [404],
  method_not_allowed: [405],
  authorization_changed: [409],
  authorization_unavailable: [503],
  internal_error: [500],
}

/** Identifies an upstream SDK failure after local session validation succeeded. */
export interface TradeScriptAuthorizationFailure {
  readonly source: 'tradescript-authorization'
  readonly code?: TradeScriptAuthorizationErrorCode
}
