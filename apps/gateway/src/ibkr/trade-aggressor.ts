export type TradeAggressor = 'buy' | 'sell'

export interface TopOfBook {
  bid?: number | undefined
  ask?: number | undefined
}

/**
 * Infers which side initiated each print, since IBKR's tick-by-tick trades carry no aggressor.
 * Lee–Ready: a print at or through the ask is a buy, at or through the bid a sell, and one inside
 * the spread takes the nearer side. At the midpoint, or without a usable quote, the tick test
 * decides: an uptick is a buy, a downtick a sell, and a repeated price keeps the last direction.
 */
export class AggressorClassifier {
  private lastPrice: number | undefined
  private lastDirection: TradeAggressor | undefined

  classify(price: number, book: TopOfBook | undefined): TradeAggressor | undefined {
    const tick = this.tickTest(price)
    if (!book || !usableBook(book)) return tick
    const { bid, ask } = book as { bid: number; ask: number }
    if (price >= ask) return 'buy'
    if (price <= bid) return 'sell'
    const mid = (bid + ask) / 2
    if (price > mid) return 'buy'
    if (price < mid) return 'sell'
    return tick
  }

  private tickTest(price: number): TradeAggressor | undefined {
    if (this.lastPrice !== undefined && price !== this.lastPrice)
      this.lastDirection = price > this.lastPrice ? 'buy' : 'sell'
    this.lastPrice = price
    return this.lastDirection
  }
}

function usableBook(book: TopOfBook): boolean {
  return (
    Number.isFinite(book.bid) &&
    Number.isFinite(book.ask) &&
    (book.bid as number) > 0 &&
    (book.ask as number) >= (book.bid as number)
  )
}
