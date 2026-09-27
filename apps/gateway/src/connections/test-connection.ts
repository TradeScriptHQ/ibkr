import { EventName, IBApi } from '@stoqey/ib'
import { RequestError } from '../ibkr/request-error.js'

/** A short-lived API handshake; never requests or changes orders. */
export function discoverTwsAccounts(
  host: string,
  port: number,
  clientId: number,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const api = new IBApi({ host, port, clientId })
    const finish = (error?: Error, accounts?: string[]) => {
      clearTimeout(timer)
      api.removeAllListeners()
      api.on(EventName.error, () => {})
      api.disconnect()
      if (error) reject(error)
      else resolve(accounts ?? [])
    }
    const timer = setTimeout(
      () =>
        finish(
          new RequestError(
            408,
            'TWS did not respond. Check the port and enable API connections in TWS.',
          ),
        ),
      10000,
    )
    api.once(EventName.managedAccounts, (csv: string) =>
      finish(undefined, [
        ...new Set(
          csv
            .split(',')
            .map((account) => account.trim())
            .filter(Boolean),
        ),
      ]),
    )
    api.once(EventName.disconnected, () =>
      finish(new RequestError(400, 'TWS disconnected before returning its accounts.')),
    )
    api.on(EventName.error, (_error: Error, code: number) => {
      if (code === 326)
        finish(new RequestError(409, 'This client ID is already in use. Choose another client ID.'))
      else if (code === 502 || code === 504)
        finish(new RequestError(400, 'Could not connect to TWS. Check the port and API settings.'))
    })
    try {
      api.connect()
    } catch {
      finish(new RequestError(400, 'Could not connect to TWS.'))
    }
  })
}
