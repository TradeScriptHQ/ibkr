import { randomUUID } from 'node:crypto'
import type { GatewayEvent, GatewayEventEnvelope } from '@ibkr-terminal/contracts'

type Subscriber = (envelope: GatewayEventEnvelope) => void

export type BacklogResult =
  | { readonly status: 'ok'; readonly events: readonly GatewayEventEnvelope[] }
  | {
      readonly status: 'resync-required'
      readonly reason: 'cursor-gap' | 'generation-changed'
    }

export class EventStream {
  readonly #generation = randomUUID()
  readonly #capacity: number
  readonly #events: GatewayEventEnvelope[] = []
  readonly #subscribers = new Set<Subscriber>()
  #cursor = 0

  constructor(capacity = 2_000) {
    this.#capacity = capacity
  }

  get generation(): string {
    return this.#generation
  }

  get cursor(): number {
    return this.#cursor
  }

  publish(event: GatewayEvent): GatewayEventEnvelope {
    this.#cursor += 1
    const envelope: GatewayEventEnvelope = {
      sessionGeneration: this.#generation,
      cursor: this.#cursor,
      occurredAt: new Date().toISOString(),
      event,
    }
    this.#events.push(envelope)
    if (this.#events.length > this.#capacity) this.#events.shift()
    for (const subscriber of this.#subscribers) subscriber(envelope)
    return envelope
  }

  backlog(sessionGeneration: string, afterCursor: number): BacklogResult {
    if (sessionGeneration !== this.#generation) {
      return { status: 'resync-required', reason: 'generation-changed' }
    }
    const firstCursor = this.#events[0]?.cursor ?? this.#cursor + 1
    if (afterCursor < firstCursor - 1) {
      return { status: 'resync-required', reason: 'cursor-gap' }
    }
    return { status: 'ok', events: this.#events.filter(({ cursor }) => cursor > afterCursor) }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }
}
