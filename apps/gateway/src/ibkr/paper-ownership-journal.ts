import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { Contract } from '@stoqey/ib'
import { fromIbSymbol } from './contracts.js'
import type { BrokerSymbol, Execution, Order, PaperOwnershipRecovery } from './types.js'

export const PAPER_OWNER_FIELD = 'paperE2EOwner'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
export function paperOwnershipId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !UUID.test(value))
    throw new Error('Paper ownership requires a unique canonical UUID')
  return value
}
export function paperOrderReference(ownerId: string, originalOrderId: number): string {
  paperOwnershipId(ownerId)
  if (!Number.isInteger(originalOrderId) || originalOrderId === 0)
    throw new Error('Paper ownership requires a native API order binding')
  return `tspe:${ownerId}:${originalOrderId}`
}
export interface PaperOwnershipScope {
  host: string
  port: number
  clientId: number
  environment: 'paper'
}
interface NativeTarget {
  securityType: string
  conId?: number | undefined
  currency: string
  legs: { conId: number; ratio: number; action: string }[]
}
interface Entry {
  ownerId: string
  reference: string
  native: NativeTarget
  order: Order
  brokerSeen: boolean
  executions: Execution[]
  /** Descriptive terms copied only from provider ContractDetails before dispatch. */
  resolvedContracts?: BrokerSymbol[]
  executionCoverageComplete?: boolean
}
interface Journal {
  version: 1
  scope: PaperOwnershipScope
  entries: Entry[]
}
const positiveId = (id: unknown): id is number =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0
const terminal = (order: Order) =>
  ['filled', 'cancelled', 'rejected'].includes(order.status) ||
  (order.status === 'inactive' && order.customFields?.ibkrCompleted === true)
function nativeTarget(contract: Contract): NativeTarget {
  const securityType = String(contract.secType ?? ''),
    currency = String(contract.currency ?? '')
  if (!securityType || !currency)
    throw new Error('Paper ownership requires a qualified native contract and currency')
  if (securityType !== 'BAG' && !positiveId(contract.conId))
    throw new Error('Paper ownership requires an exact qualified native contract ID')
  const legs = (contract.comboLegs ?? []).map((leg) => {
    if (!positiveId(leg.conId) || !Number.isInteger(leg.ratio) || !(Number(leg.ratio) > 0))
      throw new Error('Paper ownership requires exact native combo legs and positive ratios')
    if (!['BUY', 'SELL'].includes(String(leg.action)))
      throw new Error('Paper ownership requires known native combo leg directions')
    return { conId: leg.conId, ratio: Number(leg.ratio), action: String(leg.action) }
  })
  if (securityType === 'BAG' && legs.length < 2)
    throw new Error('Paper ownership requires the resolved native combo legs')
  if (new Set(legs.map((leg) => leg.conId)).size !== legs.length)
    throw new Error('Paper ownership cannot bind ambiguous repeated native combo legs')
  return { securityType, conId: contract.conId, currency, legs }
}
function revision(id: string): { identity: string; number?: number } {
  const match = /^(.*)\.(\d+)$/u.exec(id)
  return match ? { identity: match[1]!, number: Number(match[2]) } : { identity: id }
}
function expectedSecurityType(
  entry: Pick<Entry, 'order' | 'native'>,
  conId: number | undefined,
): string | undefined {
  if (entry.native.securityType !== 'BAG') return entry.native.securityType
  const legs = entry.order.strategyLegs?.length ? entry.order.strategyLegs : entry.order.optionLegs
  const source = legs?.find(
    (leg) =>
      Number(
        'contract' in leg ? leg.contract.brokerContractId : leg.symbolInfo.contractIdentity?.conId,
      ) === conId,
  )
  return source
    ? 'contract' in source
      ? source.contract.underlyingSymbolInfo.assetClass === 'futures'
        ? 'FOP'
        : 'OPT'
      : 'STK'
    : undefined
}
function expectedExecutionSide(
  entry: Pick<Entry, 'order' | 'native'>,
  symbol: BrokerSymbol,
): Order['side'] | undefined {
  if (entry.native.securityType !== 'BAG' || symbol.contractIdentity?.securityType === 'BAG')
    return entry.order.side
  const leg = entry.native.legs.find((item) => item.conId === symbol.contractIdentity?.conId)
  return leg
    ? leg.action === 'BUY'
      ? entry.order.side
      : entry.order.side === 'buy'
        ? 'sell'
        : 'buy'
    : undefined
}
function resolvedSymbol(entry: Entry, incoming: BrokerSymbol): BrokerSymbol {
  const identity = incoming.contractIdentity
  const qualified = entry.resolvedContracts?.find(
    (symbol) => symbol.contractIdentity?.conId === identity?.conId,
  )
  if (!qualified) return incoming
  if (
    !identity ||
    !qualified.contractIdentity ||
    incoming.currency !== qualified.currency ||
    identity.securityType !== qualified.contractIdentity.securityType
  )
    throw new Error(
      'Native contract class or currency contradicts provider-resolved ownership terms',
    )
  for (const field of ['expiry', 'strike', 'right', 'multiplier', 'tradingClass'] as const) {
    const actual = identity?.[field],
      expected = qualified.contractIdentity?.[field]
    const normalized = (value: unknown) =>
      field === 'expiry' && typeof value === 'string' ? value.replace(/[-\s]/gu, '') : value
    if (
      actual !== undefined &&
      expected !== undefined &&
      normalized(actual) !== normalized(expected)
    )
      throw new Error('Native descriptive terms contradict provider-resolved ownership terms')
  }
  return {
    ...qualified,
    ...incoming,
    contractIdentity: {
      ...qualified.contractIdentity,
      ...Object.fromEntries(
        Object.entries(identity ?? {}).filter(([, value]) => value !== undefined),
      ),
      securityType: identity.securityType,
    },
  }
}
function validateStoredEntry(entry: Entry, scope: PaperOwnershipScope): void {
  const order = entry.order,
    target = entry.native
  if (
    !order ||
    !target ||
    typeof entry.brokerSeen !== 'boolean' ||
    (entry.executionCoverageComplete !== undefined &&
      typeof entry.executionCoverageComplete !== 'boolean') ||
    typeof order.id !== 'string' ||
    !order.id ||
    typeof order.accountId !== 'string' ||
    !order.accountId ||
    order.clientId !== scope.clientId ||
    !Number.isInteger(order.brokerOrderId) ||
    order.brokerOrderId === 0 ||
    !['buy', 'sell'].includes(order.side) ||
    ![
      'placing',
      'pre-submitted',
      'working',
      'partially-filled',
      'filled',
      'cancelled',
      'rejected',
      'inactive',
    ].includes(order.status) ||
    !Number.isFinite(order.quantity) ||
    !(order.quantity > 0) ||
    (order.filledQuantity !== undefined &&
      (!Number.isFinite(order.filledQuantity) ||
        order.filledQuantity < 0 ||
        order.filledQuantity > order.quantity)) ||
    (order.permId !== undefined && !positiveId(order.permId)) ||
    typeof order.submittedAt !== 'string' ||
    typeof order.updatedAt !== 'string' ||
    typeof entry.reference !== 'string' ||
    !new RegExp(`^tspe:${entry.ownerId}:-?[1-9]\\d*$`, 'u').test(entry.reference) ||
    typeof target.currency !== 'string' ||
    !target.currency ||
    !Array.isArray(target.legs) ||
    (target.securityType === 'BAG' ? target.legs.length < 2 : !positiveId(target.conId)) ||
    !order.symbol ||
    order.symbol.currency !== target.currency ||
    target.legs.some(
      (leg) =>
        !positiveId(leg.conId) ||
        !Number.isInteger(leg.ratio) ||
        leg.ratio <= 0 ||
        !['BUY', 'SELL'].includes(leg.action),
    ) ||
    new Set(target.legs.map((leg) => leg.conId)).size !== target.legs.length ||
    (target.securityType !== 'BAG' &&
      (order.symbol.contractIdentity?.conId !== target.conId ||
        order.symbol.contractIdentity?.securityType !== target.securityType))
  )
    throw new Error('Paper ownership journal contains malformed native intent or order facts')
  const identities = new Set<string>()
  if (
    entry.resolvedContracts !== undefined &&
    (!Array.isArray(entry.resolvedContracts) ||
      entry.resolvedContracts.some(
        (symbol) =>
          !symbol ||
          symbol.currency !== target.currency ||
          !positiveId(symbol.contractIdentity?.conId) ||
          symbol.contractIdentity.securityType !==
            expectedSecurityType(entry, symbol.contractIdentity.conId) ||
          (target.securityType === 'BAG'
            ? !target.legs.some((leg) => leg.conId === symbol.contractIdentity?.conId)
            : symbol.contractIdentity.conId !== target.conId),
      ) ||
      new Set(entry.resolvedContracts.map((symbol) => symbol.contractIdentity?.conId)).size !==
        entry.resolvedContracts.length)
  )
    throw new Error('Paper ownership journal contains malformed provider-resolved contracts')
  for (const execution of entry.executions) {
    const key = revision(execution.id).identity
    if (
      !execution ||
      typeof execution.id !== 'string' ||
      !execution.id ||
      identities.has(key) ||
      execution.orderId !== order.id ||
      execution.accountId !== order.accountId ||
      execution.clientId !== scope.clientId ||
      execution.brokerOrderRef !== entry.reference ||
      (positiveId(order.permId) && execution.permId !== order.permId) ||
      !['buy', 'sell'].includes(execution.side) ||
      execution.side !== expectedExecutionSide(entry, execution.symbol) ||
      !Number.isFinite(execution.quantity) ||
      !(execution.quantity > 0) ||
      !Number.isFinite(execution.price) ||
      execution.price < 0 ||
      typeof execution.timestamp !== 'string' ||
      !execution.symbol ||
      execution.symbol.currency !== target.currency ||
      (execution.cumulativeQuantity !== undefined &&
        (!Number.isFinite(execution.cumulativeQuantity) ||
          execution.cumulativeQuantity < execution.quantity)) ||
      (target.securityType === 'BAG'
        ? execution.symbol.contractIdentity?.securityType !== 'BAG' &&
          !target.legs.some((leg) => leg.conId === execution.symbol.contractIdentity?.conId)
        : execution.symbol.contractIdentity?.conId !== target.conId ||
          execution.symbol.contractIdentity?.securityType !== target.securityType)
    )
      throw new Error('Paper ownership journal contains malformed native execution facts')
    identities.add(key)
    resolvedSymbol(entry, execution.symbol)
  }
}

/** Durable authority for tagged paper requests, never inferred from account positions. */
export class PaperOwnershipJournal {
  private data: Journal
  private reconciled = false
  private readonly executionReplays = new Set<string>()
  private readonly continuousOwners = new Set<string>()
  private failure: Error | undefined
  readonly path: string
  constructor(
    directory: string,
    readonly scope: PaperOwnershipScope,
  ) {
    if (scope.environment !== 'paper' || !Number.isInteger(scope.clientId) || scope.clientId < 0)
      throw new Error('Ownership recovery is restricted to a paper native client scope')
    const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    this.path = join(directory, `paper-ownership-${key}.json`)
    this.data = { version: 1, scope: structuredClone(scope), entries: [] }
    if (!existsSync(this.path)) return
    const stat = lstatSync(this.path)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error('Paper ownership journal must be a private regular file')
    const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('scope' in parsed) ||
      JSON.stringify(parsed.scope) !== JSON.stringify(scope) ||
      !('entries' in parsed) ||
      !Array.isArray(parsed.entries)
    )
      throw new Error('Paper ownership journal has invalid scope or format')
    this.data = parsed as Journal
    const refs = new Set<string>(),
      roots = new Set<string>()
    for (const entry of this.data.entries) {
      if (
        paperOwnershipId(entry.ownerId) !== entry.ownerId ||
        entry.order.customFields?.[PAPER_OWNER_FIELD] !== entry.ownerId ||
        entry.order.brokerOrderRef !== entry.reference ||
        !entry.order.accountId ||
        !entry.native?.securityType ||
        !Array.isArray(entry.executions) ||
        refs.has(entry.reference)
      )
        throw new Error('Paper ownership journal contains ambiguous or invalid authority')
      refs.add(entry.reference)
      validateStoredEntry(entry, scope)
      if (!entry.order.parentId) {
        if (roots.has(entry.ownerId)) throw new Error('Paper ownership journal repeats a root UUID')
        roots.add(entry.ownerId)
      }
    }
    // Previously seen working orders are durable intent, not current socket readiness.
    // Only an exact fresh native acknowledgement can clear this restored uncertainty.
    for (const entry of this.data.entries) {
      if (terminal(entry.order)) continue
      entry.brokerSeen = false
      entry.order = {
        ...entry.order,
        status: 'inactive',
        customFields: {
          ...entry.order.customFields,
          ibkrMissingOpenOrder: true,
          ibkrOwnershipRestored: true,
        },
      }
    }
  }

  private persist(next: Journal): void {
    if (this.failure) throw this.failure
    const temporary = `${this.path}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(next))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, this.path)
      const directory = openSync(dirname(this.path), 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
      this.data = next
    } catch {
      this.failure = new Error(
        'Paper ownership journal is unavailable; dispatch is blocked and any prior outcome remains unknown',
      )
      throw this.failure
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }

  /** Must finish durably before the first native dispatch; repeated roots are not retries. */
  prepare(order: Order, contract: Contract, providerContracts?: readonly Contract[]): Order {
    const ownerId = paperOwnershipId(order.customFields?.[PAPER_OWNER_FIELD])
    if (!ownerId) return order
    if (this.failure) throw this.failure
    if (!order.accountId || !Number.isInteger(order.brokerOrderId) || order.brokerOrderId === 0)
      throw new Error('Paper ownership requires exact account and native API binding')
    const reference = paperOrderReference(ownerId, order.brokerOrderId!)
    if (this.data.entries.some((entry) => entry.reference === reference))
      throw new Error(
        'Paper ownership attempt has already been prepared; outcome must be recovered',
      )
    const root = this.data.entries.find(
      (entry) => entry.ownerId === ownerId && !entry.order.parentId,
    )
    if (order.parentId ? !root || root.order.id !== order.parentId : root)
      throw new Error('Paper ownership UUID cannot be reused by an independent submission')
    const prepared: Order = {
      ...structuredClone(order),
      clientId: this.scope.clientId,
      brokerOrderRef: reference,
      symbol:
        contract.secType === 'BAG' ||
        (order.symbol.contractIdentity?.conId === contract.conId &&
          order.symbol.contractIdentity?.securityType === contract.secType)
          ? structuredClone(order.symbol)
          : fromIbSymbol(contract),
      customFields: { ...order.customFields, ibkrSecurityType: contract.secType },
    }
    if (contract.secType === 'BAG') {
      const bindOption = (leg: NonNullable<Order['optionLegs']>[number], index: number) => {
        const conId = contract.comboLegs?.[index]?.conId
        if (
          !positiveId(conId) ||
          (leg.contract.brokerContractId !== undefined &&
            Number(leg.contract.brokerContractId) !== conId)
        )
          throw new Error('Resolved native combo leg contradicts its exact retained intent')
        return { ...leg, contract: { ...leg.contract, brokerContractId: conId } }
      }
      prepared.optionLegs = prepared.optionLegs?.map(bindOption)
      prepared.strategyLegs = prepared.strategyLegs?.map((leg, index) => {
        if (leg.instrument === 'option') return { ...leg, ...bindOption(leg, index) }
        const conId = contract.comboLegs?.[index]?.conId
        if (!positiveId(conId)) throw new Error('Resolved equity combo leg has no native identity')
        if (
          leg.symbolInfo.contractIdentity?.conId !== undefined &&
          leg.symbolInfo.contractIdentity.conId !== conId
        )
          throw new Error('Resolved equity combo leg contradicts its exact retained intent')
        return {
          ...leg,
          symbolInfo: {
            ...leg.symbolInfo,
            contractIdentity: { ...leg.symbolInfo.contractIdentity, securityType: 'STK', conId },
          },
        }
      })
    }
    const next = structuredClone(this.data)
    const entry: Entry = {
      ownerId,
      reference,
      native: nativeTarget(contract),
      order: prepared,
      brokerSeen: false,
      executions: [],
    }
    if (providerContracts) {
      const expectedIds =
        entry.native.securityType === 'BAG'
          ? entry.native.legs.map((leg) => leg.conId)
          : [entry.native.conId]
      const resolved = providerContracts.map(fromIbSymbol)
      if (
        resolved.length !== expectedIds.length ||
        resolved.some(
          (symbol, index) =>
            symbol.contractIdentity?.conId !== expectedIds[index] ||
            !positiveId(symbol.contractIdentity?.conId) ||
            symbol.currency !== entry.native.currency ||
            symbol.contractIdentity.securityType !==
              expectedSecurityType(entry, symbol.contractIdentity.conId),
        )
      )
        throw new Error(
          'Paper ownership requires exact provider-resolved contract class, currency and identity',
        )
      entry.resolvedContracts = resolved
    }
    validateStoredEntry(entry, this.scope)
    next.entries.push(entry)
    this.persist(next)
    if (this.reconciled) this.continuousOwners.add(ownerId)
    return prepared
  }

  private entryFor(
    order: Pick<Order, 'brokerOrderRef' | 'permId' | 'accountId'>,
  ): Entry | undefined {
    const matches = this.data.entries.filter((entry) =>
      order.brokerOrderRef
        ? entry.reference === order.brokerOrderRef
        : positiveId(order.permId) &&
          entry.order.permId === order.permId &&
          entry.order.accountId === order.accountId,
    )
    if (matches.length > 1) throw new Error('Ambiguous durable paper ownership binding')
    return matches[0]
  }

  /** Exact native OrderRef/permId binds only to an intent already present in this journal. */
  adoptOrder(incoming: Order, contract?: Contract): Order | undefined {
    const entry = this.entryFor(incoming)
    if (!entry) return undefined
    if (entry.native.securityType === 'BAG') {
      if (!contract) throw new Error('Owned combo readback omitted its exact native leg structure')
      const actual = nativeTarget(contract)
      const sorted = (legs: NativeTarget['legs']) => [...legs].sort((a, b) => a.conId - b.conId)
      if (
        actual.securityType !== entry.native.securityType ||
        actual.currency !== entry.native.currency ||
        JSON.stringify(sorted(actual.legs)) !== JSON.stringify(sorted(entry.native.legs))
      )
        throw new Error('Native combo readback contradicts its immutable exact leg structure')
    }
    if (
      incoming.accountId !== entry.order.accountId ||
      incoming.side !== entry.order.side ||
      incoming.customFields?.ibkrReadbackUnsupported === true ||
      incoming.clientId !== this.scope.clientId ||
      (positiveId(entry.order.permId) && incoming.permId !== entry.order.permId) ||
      incoming.symbol.currency !== entry.native.currency ||
      incoming.symbol.contractIdentity?.securityType !== entry.native.securityType ||
      (entry.native.securityType !== 'BAG' &&
        incoming.symbol.contractIdentity.conId !== entry.native.conId)
    )
      throw new Error('Native paper readback contradicts its durable ownership intent')
    return {
      ...structuredClone(entry.order),
      ...incoming,
      symbol: resolvedSymbol(entry, incoming.symbol),
      id: entry.order.id,
      brokerOrderRef: entry.reference,
      optionLegs: entry.order.optionLegs ?? incoming.optionLegs,
      strategyLegs: entry.order.strategyLegs ?? incoming.strategyLegs,
      parentId: entry.order.parentId,
      bracketGroupId: entry.order.bracketGroupId,
      submittedAt: entry.order.submittedAt,
      customFields: {
        ...entry.order.customFields,
        ...incoming.customFields,
        [PAPER_OWNER_FIELD]: entry.ownerId,
      },
    }
  }

  recordOrder(order: Order, brokerSeen = false): void {
    const entry = this.entryFor(order)
    if (!entry) return
    if (
      order.id !== entry.order.id ||
      order.side !== entry.order.side ||
      order.accountId !== entry.order.accountId ||
      order.customFields?.[PAPER_OWNER_FIELD] !== entry.ownerId ||
      order.brokerOrderRef !== entry.reference ||
      (positiveId(entry.order.permId) && order.permId !== entry.order.permId)
    )
      throw new Error('Durable paper ownership cannot be overwritten by a different binding')
    if (JSON.stringify(entry.order) === JSON.stringify(order) && (!brokerSeen || entry.brokerSeen))
      return
    const next = structuredClone(this.data),
      saved = next.entries.find((candidate) => candidate.reference === entry.reference)!
    saved.order = structuredClone(order)
    saved.brokerSeen ||= brokerSeen
    validateStoredEntry(saved, this.scope)
    if (
      entry.order.status !== order.status ||
      entry.order.quantity !== order.quantity ||
      entry.order.filledQuantity !== order.filledQuantity
    )
      for (const member of next.entries.filter((item) => item.ownerId === entry.ownerId))
        member.executionCoverageComplete = false
    this.persist(next)
  }

  assertModification(order: Order, contract: Contract): void {
    const entry = this.entryFor(order)
    if (!entry) return
    if (
      order.customFields?.[PAPER_OWNER_FIELD] !== entry.ownerId ||
      order.accountId !== entry.order.accountId ||
      order.side !== entry.order.side ||
      JSON.stringify(nativeTarget(contract)) !== JSON.stringify(entry.native)
    )
      throw new Error('An owned modification cannot change its immutable native ownership target')
    this.recordOrder(order)
  }

  recordExecution(incoming: Execution): Execution | undefined {
    const entry = this.entryFor(incoming)
    if (!entry) return undefined
    const identity = incoming.symbol.contractIdentity
    if (
      incoming.accountId !== entry.order.accountId ||
      incoming.clientId !== this.scope.clientId ||
      (positiveId(entry.order.permId) && incoming.permId !== entry.order.permId) ||
      incoming.symbol.currency !== entry.native.currency ||
      !['buy', 'sell'].includes(incoming.side) ||
      incoming.side !== expectedExecutionSide(entry, incoming.symbol) ||
      !Number.isFinite(incoming.quantity) ||
      !(incoming.quantity > 0) ||
      !Number.isFinite(incoming.price) ||
      incoming.price < 0 ||
      (incoming.cumulativeQuantity !== undefined &&
        (!Number.isFinite(incoming.cumulativeQuantity) ||
          incoming.cumulativeQuantity < incoming.quantity)) ||
      !incoming.id ||
      (entry.native.securityType === 'BAG'
        ? identity?.securityType !== 'BAG' &&
          (!entry.native.legs.some((leg) => leg.conId === identity?.conId) ||
            identity?.securityType !== expectedSecurityType(entry, identity?.conId))
        : identity?.conId !== entry.native.conId ||
          identity?.securityType !== entry.native.securityType)
    )
      throw new Error('Native execution contradicts the exact durable paper ownership binding')
    const leg = entry.native.legs.find((candidate) => candidate.conId === identity?.conId)
    if (
      leg &&
      incoming.side !==
        (leg.action === 'BUY' ? entry.order.side : entry.order.side === 'buy' ? 'sell' : 'buy')
    )
      throw new Error('Native leg execution direction contradicts its immutable combo intent')
    const execution: Execution = {
      ...structuredClone(incoming),
      symbol: resolvedSymbol(entry, incoming.symbol),
      orderId: entry.order.id,
      brokerOrderRef: entry.reference,
    }
    const correction = revision(execution.id)
    const prior = entry.executions.find(
      (candidate) =>
        candidate.id === execution.id || revision(candidate.id).identity === correction.identity,
    )
    if (
      prior &&
      !Number.isFinite(Date.parse(execution.timestamp)) &&
      Number.isFinite(Date.parse(prior.timestamp))
    )
      execution.timestamp = prior.timestamp
    if (
      prior &&
      (prior.symbol.contractIdentity?.conId !== identity?.conId || prior.side !== execution.side)
    )
      throw new Error('Execution correction changed its native leg identity or direction')
    if (
      prior &&
      correction.number !== undefined &&
      revision(prior.id).number !== undefined &&
      correction.number < revision(prior.id).number!
    )
      return undefined
    if (prior && JSON.stringify(prior) === JSON.stringify(execution)) return execution
    const next = structuredClone(this.data),
      saved = next.entries.find((candidate) => candidate.reference === entry.reference)!
    saved.executions = prior
      ? saved.executions.map((candidate) => (candidate.id === prior.id ? execution : candidate))
      : [...saved.executions, execution]
    if (!saved.order.permId && positiveId(execution.permId)) saved.order.permId = execution.permId
    saved.brokerSeen = true
    for (const member of next.entries.filter((item) => item.ownerId === entry.ownerId))
      member.executionCoverageComplete = false
    this.persist(next)
    this.executionReplays.delete(entry.ownerId)
    return execution
  }

  beginReconciliation(): void {
    this.reconciled = false
    this.executionReplays.clear()
    this.continuousOwners.clear()
  }
  markUnknown(binding: Pick<Order, 'brokerOrderRef' | 'permId' | 'accountId'>): void {
    const entry = this.entryFor(binding)
    if (!entry) return
    const next = structuredClone(this.data),
      saved = next.entries.find((item) => item.reference === entry.reference)!
    saved.order.customFields = { ...saved.order.customFields, ibkrOwnershipContradiction: true }
    for (const member of next.entries.filter((item) => item.ownerId === entry.ownerId))
      member.executionCoverageComplete = false
    this.continuousOwners.delete(entry.ownerId)
    this.executionReplays.delete(entry.ownerId)
    this.persist(next)
  }
  finishReconciliation(): void {
    this.reconciled = true
  }
  finishExecutionReplay(ownerId: string): void {
    this.recovery(ownerId)
    const members = this.data.entries.filter((entry) => entry.ownerId === ownerId)
    if (
      this.continuousOwners.has(ownerId) &&
      members.every(
        (entry) =>
          terminal(entry.order) &&
          entry.brokerSeen &&
          entry.order.customFields?.ibkrMissingOpenOrder !== true,
      )
    ) {
      const next = structuredClone(this.data)
      for (const entry of next.entries.filter((item) => item.ownerId === ownerId))
        entry.executionCoverageComplete = true
      this.persist(next)
    }
    this.executionReplays.add(ownerId)
  }
  restored(): { orders: Order[]; executions: Execution[] } {
    return {
      orders: this.data.entries.map((entry) => ({
        ...structuredClone(entry.order),
        ...(!terminal(entry.order)
          ? {
              status: 'inactive' as const,
              customFields: {
                ...entry.order.customFields,
                ibkrMissingOpenOrder: true,
                ibkrOwnershipRestored: true,
              },
            }
          : {}),
      })),
      executions: this.data.entries.flatMap((entry) => structuredClone(entry.executions)),
    }
  }
  recovery(ownerId: string): PaperOwnershipRecovery {
    paperOwnershipId(ownerId)
    const entries = this.data.entries.filter((entry) => entry.ownerId === ownerId)
    if (!entries.length) throw new Error('No durable paper ownership intent matches this UUID')
    return {
      ownerId,
      orders: entries.map((entry) => structuredClone(entry.order)),
      executions: entries.flatMap((entry) => structuredClone(entry.executions)),
      reconciled: this.reconciled && !this.failure,
      executionsReconciled: this.executionReplays.has(ownerId) && !this.failure,
      executionCoverageFromDispatch:
        entries.every((entry) => entry.executionCoverageComplete === true) && !this.failure,
      outcome:
        !this.failure &&
        entries.every(
          (entry) =>
            entry.brokerSeen &&
            entry.order.customFields?.ibkrMissingOpenOrder !== true &&
            entry.order.customFields?.ibkrOwnershipContradiction !== true,
        )
          ? 'known'
          : 'unknown',
    }
  }
}
