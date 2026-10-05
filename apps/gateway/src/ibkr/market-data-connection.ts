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
      const prefix =
        code === 2108
          ? /market data farm connection is inactive(?: but should be available upon demand)?[:.]\s*([\w-]+(?:\.[\w-]+)*)\.?\s*$/i
          : /market data farm connection is (?:broken|OK):\s*([\w-]+(?:\.[\w-]+)*)\.?\s*$/i
      const farm = prefix.exec(message)?.[1]
      if (farm) this.farms.set(farm, code !== 2103)
    } else return undefined
    const failed = [...this.farms].filter(([, available]) => !available).map(([farm]) => farm)
    if (this.upstreamLost)
      return { status: 'disconnected', message: 'TWS has lost its connection to IBKR.' }
    if (failed.length)
      return { status: 'degraded', message: `Market data disconnected: ${failed.join(', ')}` }
    return { status: 'connected', message }
  }
}
