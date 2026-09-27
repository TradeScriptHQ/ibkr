/** Shared high-watermark allocator for every order consumer on one TWS API connection. */
export class OrderIdAllocator {
  private nextOrderId: number | undefined

  observeNextValid(orderId: number): void {
    if (!Number.isInteger(orderId) || orderId < 0) return
    this.nextOrderId = Math.max(this.nextOrderId ?? orderId, orderId)
  }

  observeUsed(orderId: number): void {
    if (!Number.isInteger(orderId) || orderId < 0) return
    this.nextOrderId = Math.max(this.nextOrderId ?? orderId + 1, orderId + 1)
  }

  allocate(): number | undefined {
    if (this.nextOrderId === undefined) return undefined
    const allocated = this.nextOrderId
    this.nextOrderId += 1
    return allocated
  }
}
