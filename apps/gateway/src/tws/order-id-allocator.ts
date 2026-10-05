const MAX_API_ID = 2_147_483_647

/** Shared order high-watermark and retained request ownership for one TWS API connection. */
export class OrderIdAllocator {
  private nextOrderId: number | undefined
  private nextRequestId = 1
  private readonly requestIds = new Set<number>()

  observeNextValid(orderId: number): void {
    if (!Number.isInteger(orderId) || orderId < 0) return
    this.nextOrderId = Math.max(this.nextOrderId ?? 1, orderId, 1)
  }

  observeUsed(orderId: number): void {
    if (!Number.isInteger(orderId) || orderId < 0) return
    this.nextOrderId = Math.max(this.nextOrderId ?? orderId + 1, orderId + 1)
  }

  allocate(): number | undefined {
    if (this.nextOrderId === undefined) return undefined
    while (this.requestIds.has(this.nextOrderId)) this.nextOrderId += 1
    if (this.nextOrderId > MAX_API_ID) throw new RangeError('IBKR API order IDs are exhausted.')
    const allocated = this.nextOrderId
    this.nextOrderId += 1
    return allocated
  }

  allocateRequestId(): number {
    // Start beyond all order IDs already allocated or observed. Future orders skip
    // these IDs, and cancelled requests retain ownership for delayed broker errors.
    const allocated = Math.max(this.nextRequestId, this.nextOrderId ?? 1)
    if (allocated > MAX_API_ID) throw new RangeError('IBKR API request IDs are exhausted.')
    this.nextRequestId = allocated + 1
    this.requestIds.add(allocated)
    return allocated
  }

  ownsRequestId(requestId: number): boolean {
    return this.requestIds.has(requestId)
  }
}
