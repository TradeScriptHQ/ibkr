import type { MarketDataConnection } from './types.js'

/** Tracks upstream connectivity separately from the local TWS socket. */
export class MarketDataConnectionTracker {
  private upstreamLost = false
  private readonly farms = new Map<string, boolean>()

  reset(): MarketDataConnection {
    this.upstreamLost = false
    this.farms.clear()
    return { status: 'unknown' }
  }

  handle(code: number | undefined, message: string): MarketDataConnection | undefined {
    if (code === 1100) this.upstreamLost = true
    else if (code === 1101 || code === 1102) this.upstreamLost = false
    else if (code === 2103 || code === 2104 || code === 2108) {
      // IBKR identifies the affected farm after the final colon. Idle farms are available.
      const farm = message.slice(message.lastIndexOf(':') + 1).trim()
      this.farms.set(farm, code !== 2103)
    } else return undefined
    const failed = [...this.farms].filter(([, available]) => !available).map(([farm]) => farm)
    if (this.upstreamLost)
      return { status: 'disconnected', message: 'TWS has lost its connection to IBKR.' }
    if (failed.length)
      return { status: 'degraded', message: `Market data disconnected: ${failed.join(', ')}` }
    return { status: 'connected', message }
  }
}
