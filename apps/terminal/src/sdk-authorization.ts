import type { TradeScriptAuthorizationErrorCode } from '@ibkr-terminal/contracts'

export interface SetupStatus {
  account?: {
    state: 'signed-out' | 'authenticating' | 'signed-in' | 'mfa-required' | 'error'
    account?: { id: string; email: string }
    license?: {
      status: 'not-provisioned' | 'pending' | 'active' | 'expired' | 'inactive'
      kind?: 'trial' | 'paid' | null
      plan?: string | null
      trialStartedAt?: string | null
      trialEndsAt?: string | null
      trialDays: number
      accessEndsAt?: string | null
      credentialsAvailable: boolean
    }
    message?: string
  }
  sdk: {
    configured: boolean
    ready: boolean
    version?: string
    state?: 'unconfigured' | 'exchanging' | 'ready' | 'degraded' | 'error' | 'stopped'
    failure?: 'rejected' | 'unavailable'
    failureReason?: TradeScriptAuthorizationErrorCode
    message?: string
    expiresAt?: string
  }
  connectionConfigured: boolean
}

/** A previous lease lapsed without a failed renewal, e.g. after the computer slept. */
export function sdkRenewalPending(sdk: SetupStatus['sdk']) {
  return sdk.configured && !sdk.ready && !sdk.failure && sdk.expiresAt !== undefined
}

export function sdkAuthorizationNotice(sdk: SetupStatus['sdk']) {
  if (!sdk.configured || sdkRenewalPending(sdk)) return undefined
  if (sdk.failureReason)
    return {
      title: authorizationErrorTitles[sdk.failureReason],
      message:
        sdk.message ??
        'Retry authorization. If access remains unavailable, contact your administrator or TradeScript support.',
    }
  if (!sdk.ready && sdk.expiresAt)
    return {
      title: 'SDK authorization expired',
      message:
        sdk.failure === 'rejected'
          ? 'Your saved SDK credentials are no longer accepted. Enter valid credentials from Developer Console below, or retry after renewing your licence.'
          : 'We could not renew SDK access. Check your internet connection and retry. Your saved credentials have not been changed.',
    }
  if (sdk.failure === 'rejected')
    return {
      title: 'SDK credentials need updating',
      message:
        'Your saved SDK credentials were rejected. Check the credential ID and secret in Developer Console; they may be incorrect or revoked.',
    }
  if (sdk.failure === 'unavailable' || (!sdk.ready && sdk.state === 'error'))
    return {
      title: sdk.ready ? 'SDK renewal temporarily unavailable' : 'SDK authorization unavailable',
      message:
        'Check your internet connection and retry. Your saved credentials have not been changed.',
    }
  return undefined
}

const authorizationErrorTitles: Record<TradeScriptAuthorizationErrorCode, string> = {
  unauthorized: 'SDK credentials need updating',
  trial_access_expired: 'Free trial access has ended',
  subscription_access_expired: 'Subscription access has ended',
  subscription_inactive: 'Subscription needs attention',
  account_closed: 'Account is closed',
  client_suspended: 'SDK access is suspended',
  origin_not_authorized: 'Browser origin is not authorized',
  deployment_not_authorized: 'Application is not authorized',
  sdk_version_not_authorized: 'SDK version is not authorized',
  sdk_build_not_authorized: 'SDK build is not authorized',
  invalid_request: 'SDK authorization request needs correcting',
  not_found: 'SDK authorization endpoint was not found',
  method_not_allowed: 'SDK authorization method is not supported',
  authorization_changed: 'SDK authorization changed',
  authorization_unavailable: 'SDK authorization temporarily unavailable',
  internal_error: 'SDK authorization service error',
}

export function sdkAccessNeedsConsole(sdk: SetupStatus['sdk']) {
  return (
    sdk.failureReason === 'trial_access_expired' ||
    sdk.failureReason === 'subscription_access_expired' ||
    sdk.failureReason === 'subscription_inactive'
  )
}

export function sdkCredentialsNeedUpdating(sdk: SetupStatus['sdk']) {
  return (
    !sdk.configured ||
    sdk.failureReason === 'unauthorized' ||
    (sdk.failure === 'rejected' && sdk.failureReason === undefined)
  )
}
