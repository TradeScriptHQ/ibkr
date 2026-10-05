import { type ConnectionSnapshot, ConnectionSnapshotSchema } from '@ibkr-terminal/contracts'
import { gatewayRequest } from './ibkr/broker-request.js'
import { bootstrapBrowserSession, CLIENT_HEADERS } from './terminal-session.js'

export async function readConnection(): Promise<ConnectionSnapshot> {
  const response = await fetch('/api/v1/connection', { headers: CLIENT_HEADERS })
  if (!response.ok) throw new Error('Connection settings are unavailable.')
  return ConnectionSnapshotSchema.parse(await response.json())
}

export async function retryConnection(): Promise<ConnectionSnapshot> {
  const session = await bootstrapBrowserSession()
  const connection = await readConnection()
  return ConnectionSnapshotSchema.parse(
    await gatewayRequest(
      '/api/v1',
      '/connection/retry',
      { method: 'POST', body: { generation: connection.generation } },
      session.csrfToken,
      connection.generation,
    ),
  )
}
