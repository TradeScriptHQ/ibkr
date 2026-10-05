import {
  type ConnectionType,
  connectionTypeLabel,
  inferConnectionType,
} from '@ibkr-terminal/contracts'
import { EventName, IBApi } from '@stoqey/ib'
import { RequestError } from '../ibkr/request-error.js'

/** A short-lived API handshake; never requests or changes orders. */
export function discoverTwsAccounts(
  host: string,
  port: number,
  clientId: number,
  connectionType: ConnectionType = inferConnectionType(port),
): Promise<string[]> {
  const label = connectionTypeLabel(connectionType)
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
            `${label} did not respond. Check the port and enable API connections in ${label}.`,
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
      finish(new RequestError(400, `${label} disconnected before returning its accounts.`)),
    )
    const handleError = (code: number) => {
      if (code === 326)
        finish(new RequestError(409, 'This client ID is already in use. Choose another client ID.'))
      else if (code === 502 || code === 504)
        finish(
          new RequestError(400, `Could not connect to ${label}. Check the port and API settings.`),
        )
    }
    api.on(EventName.error, (_error: Error, code: number) => handleError(Number(code)))
    api.on(EventName.info, (_message: string, code: number) => handleError(Number(code)))
    try {
      api.connect()
    } catch {
      finish(new RequestError(400, `Could not connect to ${label}.`))
    }
  })
}
