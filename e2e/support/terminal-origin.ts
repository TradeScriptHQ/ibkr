const DEFAULT_TERMINAL_ORIGIN = 'http://localhost:3000'
const INVALID_ORIGIN = 'TERMINAL_E2E_ORIGIN must be a canonical http://localhost:<port> origin'

export function resolveTerminalE2EOrigin(value: string | undefined): string {
  if (value === undefined) return DEFAULT_TERMINAL_ORIGIN
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(INVALID_ORIGIN)
  }
  const port = Number(url.port)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== 'localhost' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    // Browser Origin headers use the canonical spelling, including default-port removal.
    url.origin !== value
  )
    throw new Error(INVALID_ORIGIN)
  return url.origin
}

export const TERMINAL_ORIGIN = resolveTerminalE2EOrigin(process.env.TERMINAL_E2E_ORIGIN)
