/** Resources belong to one startup attempt, including those created after cancellation. */
export class WorkstationLifetime {
  readonly controller = new AbortController()
  private cleanups: Array<() => void | Promise<void>> = []
  private closing?: Promise<void>

  get disposed(): boolean {
    return this.controller.signal.aborted
  }

  defer(cleanup: () => void | Promise<void>): void {
    if (this.disposed) {
      void Promise.resolve().then(cleanup).catch(console.error)
    } else {
      this.cleanups.push(cleanup)
    }
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.controller.abort()
    this.closing = this.release()
    return this.closing
  }

  private async release(): Promise<void> {
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch (error) {
        console.error('Workstation cleanup failed', error)
      }
    }
  }
}
