import { type ConnectionSnapshot, ConnectionSnapshotSchema } from '@ibkr-terminal/contracts'
import { CLIENT_HEADERS } from './terminal-session.js'

export async function readConnection(): Promise<ConnectionSnapshot> {
  const response = await fetch('/api/v1/connection', { headers: CLIENT_HEADERS })
  if (!response.ok) throw new Error('Connection settings are unavailable.')
  return ConnectionSnapshotSchema.parse(await response.json())
}
