import type { SetupStatus } from './sdk-authorization.js'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'

async function invalidLocalSession(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  try {
    const body: unknown = await response.clone().json()
    return (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'code' in body.error &&
      body.error.code === 'invalid-session'
    )
  } catch {
    return false
  }
}

/** Only this safe status read is retried; financial and credential writes are never replayed. */
export async function loadApplicationSetupStatus(
  onSessionInvalid: () => void,
): Promise<SetupStatus> {
  await bootstrapBrowserSession()
  const read = () =>
    fetch('/api/v1/setup', {
      headers: CLIENT_HEADERS,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(5000),
    })
  let response = await read()
  if (await invalidLocalSession(response)) {
    onSessionInvalid()
    await bootstrapBrowserSession(true)
    response = await read()
    if (await invalidLocalSession(response))
      throw new Error('The local session could not be restored yet. Retrying automatically.')
  }
  if (!response.ok)
    throw new Error('Could not load application setup. Check that the local gateway is running.')
  return response.json()
}
