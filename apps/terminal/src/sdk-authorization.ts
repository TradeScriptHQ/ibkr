export interface SetupStatus {
  sdk: {
    configured: boolean
    ready: boolean
    version?: string
    state?: 'unconfigured' | 'exchanging' | 'ready' | 'degraded' | 'error' | 'stopped'
    failure?: 'rejected' | 'unavailable'
    expiresAt?: string
  }
  connectionConfigured: boolean
}

export function sdkAuthorizationNotice(sdk: SetupStatus['sdk']) {
  if (!sdk.configured) return undefined
  if (!sdk.ready && sdk.expiresAt)
    return {
      title: 'SDK authorization expired',
      message:
        sdk.failure === 'rejected'
          ? 'Your saved SDK credentials are no longer accepted. Enter valid credentials from Developer Console below, or retry after renewing your licence.'
          : 'We could not renew SDK access. Check your internet connection and retry. You can also replace your credentials below.',
    }
  if (sdk.failure === 'rejected')
    return {
      title: 'SDK credentials need updating',
      message:
        'Your saved SDK credentials were rejected. They may have expired or been revoked, or your licence may need attention in Developer Console.',
    }
  if (sdk.failure === 'unavailable' || (!sdk.ready && sdk.state === 'error'))
    return {
      title: sdk.ready ? 'SDK renewal temporarily unavailable' : 'SDK authorization unavailable',
      message:
        'Check your internet connection and retry. Your saved credentials have not been changed.',
    }
  return undefined
}
