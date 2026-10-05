import { randomUUID } from 'node:crypto'
import type {
  BrokerState,
  Order,
  OrderDraft,
  PaperOwnershipRecovery,
  PositionCloseOptions,
} from '@ibkr-terminal/contracts'
import type {
  APIRequestContext,
  APIResponse,
  BrowserContext,
  Request,
  Response,
} from '@playwright/test'
import { ownsOrder } from './order-safety.js'
import {
  ownedRecoveryDrafts,
  PAPER_OWNER_FIELD,
  uniqueOrderRecords,
} from './paper-fill-recovery.js'
import { expectJsonOk, readBrokerState, type TerminalSession } from './session.js'

export interface PreparedPaperRequest {
  body: unknown
  attemptId?: string
}
interface Attempt {
  readonly id: string
  readonly tagged: boolean
  readonly intent?: OrderDraft | undefined
  readonly accountId?: string | undefined
  readonly generation?: string | undefined
  orderId?: string
  receiptAccountId?: string | undefined
  rejected?: boolean
  durableGeneration?: string | undefined
}
const isPlacement = (url: string, method: string) =>
  method.toUpperCase() === 'POST' &&
  (new URL(url, 'http://localhost').pathname === '/api/v1/ibkr/orders' ||
    /^\/api\/v1\/ibkr\/positions\/[^/]+\/close$/u.test(new URL(url, 'http://localhost').pathname))
const terminal = (order: Order) =>
  ['filled', 'cancelled', 'rejected', 'inactive'].includes(order.status) &&
  order.customFields?.ibkrMissingOpenOrder !== true

/** Test-owned transport calls cannot consume an unbounded portion of teardown. */
function boundedRequests(probe: APIRequestContext, deadline: number): APIRequestContext {
  return new Proxy(probe, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (!['get', 'post', 'delete'].includes(String(key)) || typeof value !== 'function')
        return value
      return (url: string, options?: { timeout?: number }) => {
        const remaining = deadline - Date.now()
        if (remaining <= 0)
          throw new Error('Paper cleanup transport budget exhausted; outcome remains unresolved')
        return Reflect.apply(value, target, [
          url,
          { ...options, timeout: Math.min(options?.timeout ?? 10_000, remaining) },
        ])
      }
    },
  })
}

/** Intents precede dispatch; only exact tags/receipts and linked children establish ownership. */
export function trackPaperOrders(context: BrowserContext, mutations: boolean) {
  const attempts = new Map<string, Attempt>()
  const ownedIds = new Set<string>()
  const legacyReceiptErrors: unknown[] = []
  const receipts: Promise<void>[] = []
  const browserAttempts = new WeakMap<Request, string>()
  const durable = new Map<string, PaperOwnershipRecovery>()
  const prepareRequest = (
    url: string,
    method: string,
    input: unknown,
    headers: Record<string, string> = {},
  ): PreparedPaperRequest => {
    if (!mutations || !isPlacement(url, method)) return { body: input }
    const body = (typeof input === 'string' ? JSON.parse(input) : structuredClone(input)) as {
      expectedExecutionEnvironment?: string
      draft?: OrderDraft
      context?: { accountId?: string }
      options?: PositionCloseOptions
    }
    if (!body || body.expectedExecutionEnvironment !== 'paper')
      throw new Error('Paper cleanup ownership requires an explicit paper request before dispatch')
    const orderRequest = new URL(url, 'http://localhost').pathname === '/api/v1/ibkr/orders'
    if (
      orderRequest &&
      (!body.draft || !body.draft.symbol || !['buy', 'sell'].includes(body.draft.side))
    )
      throw new Error('Paper placement has no usable pre-dispatch intent')
    if (
      body.draft?.customFields?.[PAPER_OWNER_FIELD] !== undefined ||
      body.options?.paperOwnershipId !== undefined
    )
      throw new Error('A paper ownership marker cannot be reused for another submission')
    const id = randomUUID()
    if (orderRequest)
      body.draft = {
        ...body.draft!,
        customFields: { ...body.draft!.customFields, [PAPER_OWNER_FIELD]: id },
      }
    else body.options = { ...body.options, paperOwnershipId: id }
    attempts.set(id, {
      id,
      tagged: true,
      intent: body.draft ? structuredClone(body.draft) : undefined,
      accountId: body.draft?.accountId ?? body.context?.accountId,
      generation: Object.entries(headers).find(
        ([key]) => key.toLowerCase() === 'x-tradescript-connection',
      )?.[1],
    })
    return { body, attemptId: id }
  }
  const prepareBrowserRequest = (request: Request): PreparedPaperRequest => {
    if (!mutations || !isPlacement(request.url(), request.method())) return { body: undefined }
    const prepared = prepareRequest(
      request.url(),
      request.method(),
      request.postDataJSON(),
      request.headers(),
    )
    if (prepared.attemptId) browserAttempts.set(request, prepared.attemptId)
    return prepared
  }
  const recordResponse = (
    response: Pick<APIResponse, 'status' | 'url' | 'json'>,
    method: string,
    attemptId?: string,
  ): Promise<void> => {
    if (!mutations || !isPlacement(response.url(), method)) return Promise.resolve()
    const attempt = attemptId === undefined ? undefined : attempts.get(attemptId)
    if (attemptId !== undefined && !attempt) throw new Error('Unknown paper attempt receipt')
    if (response.status() >= 400 && response.status() < 500) {
      if (attempt) attempt.rejected = true
      return Promise.resolve()
    }
    if (response.status() !== 201) return Promise.resolve()
    const receipt = response.json().then((body: { order?: Order }) => {
      if (typeof body.order?.id !== 'string' || !body.order.id)
        throw new Error('Paper placement returned no usable order receipt')
      if (attempt?.tagged && body.order.customFields?.[PAPER_OWNER_FIELD] !== attempt.id)
        throw new Error('Paper receipt omitted its exact pre-dispatch ownership marker')
      if (attempt?.orderId && attempt.orderId !== body.order.id)
        throw new Error('Two different receipts reused the same paper ownership attempt')
      ownedIds.add(body.order.id)
      if (attempt) {
        attempt.orderId = body.order.id
        attempt.receiptAccountId = body.order.accountId
      }
    })
    receipts.push(receipt)
    void receipt.catch((error) => {
      if (!attempt) legacyReceiptErrors.push(error)
    })
    return receipt
  }
  const onResponse = (response: Response) => {
    const attemptId = browserAttempts.get(response.request())
    // Fulfilled mocks which never pass the dispatch guard have no broker ownership.
    if (attemptId)
      void recordResponse(response, response.request().method(), attemptId).catch(() => undefined)
  }
  context.on('response', onResponse)

  const retainedState = (state: BrokerState): BrokerState => {
    const ids = new Set([...state.orders, ...(state.ordersHistory ?? [])].map((order) => order.id))
    return {
      ...state,
      ordersHistory: [
        ...(state.ordersHistory ?? []),
        ...[...durable.values()].flatMap((snapshot) =>
          snapshot.orders.filter((order) => !ids.has(order.id)),
        ),
      ],
      executions: [
        ...(state.executions ?? []),
        ...[...durable.values()].flatMap((snapshot) => snapshot.executions),
      ],
    }
  }
  const loadDurable = async (
    state: BrokerState,
    session: TerminalSession,
    probe: APIRequestContext,
    replay = false,
  ): Promise<BrokerState> => {
    const raw = [...state.orders, ...(state.ordersHistory ?? [])]
    for (const attempt of attempts.values()) {
      if (attempt.rejected && !attempt.orderId) continue
      const matches = raw.filter((order) => order.customFields?.[PAPER_OWNER_FIELD] === attempt.id)
      const generationChanged =
        attempt.generation !== undefined &&
        attempt.generation !== session.mutationHeaders['x-tradescript-connection'] &&
        (attempt.durableGeneration === undefined ||
          attempt.durableGeneration !== session.mutationHeaders['x-tradescript-connection'])
      if (generationChanged && !session.mutationHeaders['x-tradescript-connection'])
        throw new Error('Paper cleanup current connection generation is unavailable')
      const multi =
        replay &&
        matches.some(
          (order) => (order.optionLegs?.length ?? 0) > 1 || (order.strategyLegs?.length ?? 0) > 1,
        )
      if (matches.length && !generationChanged && !multi) continue
      const path = `/api/v1/ibkr/paper-ownership/${encodeURIComponent(attempt.id)}`
      const response = multi
        ? await probe.post(`${path}/reconcile`, {
            headers: session.mutationHeaders,
            data: { expectedExecutionEnvironment: 'paper' },
          })
        : await probe.get(path, { headers: session.mutationHeaders })
      let snapshot = await expectJsonOk<PaperOwnershipRecovery>(response)
      const needsReplay =
        replay &&
        snapshot.orders?.some(
          (order) => (order.optionLegs?.length ?? 0) > 1 || (order.strategyLegs?.length ?? 0) > 1,
        )
      if (needsReplay && !multi)
        snapshot = await expectJsonOk<PaperOwnershipRecovery>(
          await probe.post(`${path}/reconcile`, {
            headers: session.mutationHeaders,
            data: { expectedExecutionEnvironment: 'paper' },
          }),
        )
      if (
        snapshot.ownerId !== attempt.id ||
        !Array.isArray(snapshot.orders) ||
        !Array.isArray(snapshot.executions) ||
        snapshot.reconciled !== true ||
        snapshot.outcome !== 'known' ||
        (needsReplay && snapshot.executionsReconciled !== true) ||
        snapshot.orders.some(
          (order) =>
            order.customFields?.[PAPER_OWNER_FIELD] !== attempt.id ||
            !order.brokerOrderRef?.startsWith(`tspe:${attempt.id}:`),
        )
      )
        throw new Error(
          generationChanged
            ? 'Changed paper generation has no verified durable ownership binding'
            : 'Paper placement outcome unknown: no exact reconciled durable ownership match',
        )
      durable.set(attempt.id, snapshot)
      if (generationChanged)
        attempt.durableGeneration = session.mutationHeaders['x-tradescript-connection']
    }
    return retainedState(state)
  }

  const reconcileOwnership = (state: BrokerState, session: TerminalSession): Order[] => {
    state = retainedState(state)
    if (state.connectionStatus && state.connectionStatus !== 'connected')
      throw new Error('Paper cleanup connection is not ready; broker outcomes remain unresolved')
    const raw = [...state.orders, ...(state.ordersHistory ?? [])]
    const candidates = new Set([
      ...ownedIds,
      ...raw
        .filter(
          (order) =>
            typeof order.customFields?.[PAPER_OWNER_FIELD] === 'string' &&
            attempts.has(String(order.customFields[PAPER_OWNER_FIELD])),
        )
        .map((order) => order.id),
    ])
    // Once any row proves an owned child ID, retain every duplicate row of that ID
    // for consistency checks, even if another row has contradictory parent metadata.
    for (const order of raw) if (ownsOrder(order, candidates)) candidates.add(order.id)
    const records = uniqueOrderRecords({
      ...state,
      orders: state.orders.filter((order) => candidates.has(order.id)),
      ordersHistory: (state.ordersHistory ?? []).filter((order) => candidates.has(order.id)),
    })
    for (const attempt of attempts.values()) {
      if (
        attempt.generation !== undefined &&
        attempt.generation !== session.mutationHeaders['x-tradescript-connection'] &&
        (attempt.durableGeneration === undefined ||
          attempt.durableGeneration !== session.mutationHeaders['x-tradescript-connection'])
      )
        throw new Error('Paper cleanup connection generation changed after dispatch')
      const matches = attempt.tagged
        ? records.filter(
            (order) =>
              order.customFields?.[PAPER_OWNER_FIELD] === attempt.id &&
              !order.parentId &&
              (!order.bracketGroupId || order.bracketGroupId === order.id),
          )
        : []
      if (matches.length > 1) throw new Error('Ambiguous exact paper ownership marker')
      const matched = matches[0]
      if (matched && attempt.orderId && matched.id !== attempt.orderId)
        throw new Error('Paper receipt and ownership marker identify different orders')
      if (matched) {
        attempt.orderId = matched.id
        ownedIds.add(matched.id)
      }
      if (!attempt.orderId) {
        if (attempt.rejected) continue
        throw new Error(
          attempt.tagged
            ? 'Paper placement outcome unknown: no exact retained ownership match'
            : 'Paper position-close outcome unknown: transport has no retained ownership tag',
        )
      }
      const known = records.find((order) => order.id === attempt.orderId)
      if (!known) throw new Error('Owned order history is missing; its fill outcome is unknown')
      if (attempt.tagged && known.customFields?.[PAPER_OWNER_FIELD] !== attempt.id)
        throw new Error('Owned order lost its exact retained ownership marker')
      if (
        (attempt.accountId && known.accountId !== attempt.accountId) ||
        (attempt.receiptAccountId && known.accountId !== attempt.receiptAccountId)
      )
        throw new Error('Owned order account changed after dispatch')
      const hasLegs = Boolean(
        attempt.intent?.optionLegs?.length || attempt.intent?.strategyLegs?.length,
      )
      // A strategy's top-level symbol is the underlying. Its exact option target is checked
      // after readback by the fill policy; it cannot be asserted to be that underlying conId.
      const expected = hasLegs ? undefined : attempt.intent?.symbol.contractIdentity
      if (
        expected?.conId &&
        (known.symbol.contractIdentity?.conId !== expected.conId ||
          known.symbol.contractIdentity.securityType !== expected.securityType)
      )
        throw new Error('Owned order native contract changed after dispatch')
    }
    const owned = records.filter((order) => ownsOrder(order, ownedIds))
    for (const id of ownedIds)
      if (!owned.some((order) => order.id === id))
        throw new Error('Owned order history is missing; its fill outcome is unknown')
    for (const order of owned) {
      const parentId =
        order.parentId ?? (order.bracketGroupId !== order.id ? order.bracketGroupId : undefined)
      if (parentId) {
        const parent = owned.find((candidate) => candidate.id === parentId)
        if (
          !parent ||
          parent.accountId !== order.accountId ||
          (parent.symbol.contractIdentity?.conId !== undefined &&
            order.symbol.contractIdentity?.conId !== undefined &&
            (parent.symbol.contractIdentity.conId !== order.symbol.contractIdentity.conId ||
              parent.symbol.contractIdentity.securityType !==
                order.symbol.contractIdentity.securityType))
        )
          throw new Error('Owned child identity does not match its exact parent/account')
      }
      if (state.activeAccountId && order.accountId !== state.activeAccountId)
        throw new Error('Active paper account changed before cleanup')
      if (order.customFields?.ibkrMissingOpenOrder === true)
        throw new Error('Owned order absence has not been confirmed by the broker')
    }
    return owned
  }
  const pollOwnedState = async <T>(
    probe: APIRequestContext,
    session: TerminalSession,
    predicate: (orders: Order[]) => T | undefined,
    timeoutMs: number,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const current = await loadDurable(await readBrokerState(probe), session, probe)
      const value = predicate(reconcileOwnership(current, session))
      if (value !== undefined) return value
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(300, Math.max(1, deadline - Date.now()))),
      )
    }
    throw new Error(
      'Timed out waiting for exact owned terminal acknowledgement; outcome remains unresolved',
    )
  }
  const cancelOwned = async (
    originalProbe: APIRequestContext,
    session: TerminalSession,
  ): Promise<void> => {
    const phaseDeadline = Date.now() + 30_000
    const probe = boundedRequests(originalProbe, phaseDeadline)
    const initial = reconcileOwnership(
      await loadDurable(await readBrokerState(probe), session, probe),
      session,
    )
    for (const order of initial.filter((order) => !terminal(order))) {
      const state = await loadDurable(await readBrokerState(probe), session, probe)
      const current = reconcileOwnership(state, session)
      if (!current.some((candidate) => candidate.id === order.id && !terminal(candidate))) continue
      const response = await probe.delete(`/api/v1/ibkr/orders/${encodeURIComponent(order.id)}`, {
        headers: session.mutationHeaders,
        data: { expectedExecutionEnvironment: 'paper' },
      })
      if (response.status() >= 300) {
        const after = reconcileOwnership(
          await loadDurable(await readBrokerState(probe), session, probe),
          session,
        )
        if (
          ![400, 404, 409].includes(response.status()) ||
          after.some((candidate) => candidate.id === order.id && !terminal(candidate))
        )
          await expectJsonOk(response)
      } else await expectJsonOk(response)
    }
    await pollOwnedState(
      probe,
      session,
      (orders) => {
        return orders.some((order) => !terminal(order)) ? undefined : true
      },
      Math.max(1, phaseDeadline - Date.now()),
    )
  }
  return {
    prepareRequest,
    prepareBrowserRequest,
    recordResponse,
    async cleanup(originalProbe: APIRequestContext, session: TerminalSession): Promise<void> {
      const probe = boundedRequests(originalProbe, Date.now() + 120_000)
      await Promise.allSettled(receipts)
      if (legacyReceiptErrors.length)
        throw new Error('Every paper placement must retain its cleanup receipt')
      if (!ownedIds.size && !attempts.size) return
      await cancelOwned(probe, session)
      const deadline = Date.now() + 60_000
      const recoveryProbe = boundedRequests(probe, deadline)
      for (let round = 0; round < 12; round++) {
        const state = await loadDurable(
          await readBrokerState(recoveryProbe),
          session,
          recoveryProbe,
          true,
        )
        const owned = reconcileOwnership(state, session)
        if (owned.some((order) => !terminal(order)))
          throw new Error('Owned order is not terminal before fill recovery')
        const replayed = new Set(
          [...durable.values()]
            .filter((snapshot) => snapshot.executionsReconciled === true)
            .flatMap((snapshot) => snapshot.orders.map((order) => order.id)),
        )
        const covered = new Set(
          [...durable.values()]
            .filter((snapshot) => snapshot.executionCoverageFromDispatch === true)
            .flatMap((snapshot) => snapshot.orders.map((order) => order.id)),
        )
        const drafts = await ownedRecoveryDrafts(
          recoveryProbe,
          owned,
          state.executions ?? [],
          replayed,
          covered,
        )
        if (!drafts.length) return
        if (Date.now() >= deadline)
          throw new Error('Exact owned fill recovery exceeded its bounded deadline')
        const draft = drafts[0]!
        const preview = await expectJsonOk<{ accepted: boolean; confirmId?: string }>(
          await recoveryProbe.post('/api/v1/ibkr/orders/preview', {
            headers: session.mutationHeaders,
            data: { draft, expectedExecutionEnvironment: 'paper' },
          }),
        )
        if (!preview.accepted) throw new Error('Exact owned fill recovery preview was rejected')
        const prepared = prepareRequest(
          '/api/v1/ibkr/orders',
          'POST',
          {
            draft: { ...draft, confirmId: preview.confirmId },
            expectedExecutionEnvironment: 'paper',
          },
          session.mutationHeaders,
        )
        try {
          try {
            const response = await recoveryProbe.post('/api/v1/ibkr/orders', {
              headers: session.mutationHeaders,
              data: prepared.body,
            })
            await recordResponse(response, 'POST', prepared.attemptId)
            if (response.status() !== 201)
              throw new Error('Exact owned fill recovery was rejected or has an unknown outcome')
          } catch (error) {
            // An accepted response can be lost. Only its pre-dispatch UUID can recover ownership.
            reconcileOwnership(
              await loadDurable(await readBrokerState(recoveryProbe), session, recoveryProbe),
              session,
            )
            const attempt = attempts.get(prepared.attemptId!)!
            if (attempt.rejected || !attempt.orderId) throw error
          }
          const id = attempts.get(prepared.attemptId!)!.orderId
          const completedClose = await pollOwnedState(
            recoveryProbe,
            session,
            (records) => {
              const close = records.find((order) => order.id === id)
              return close && terminal(close) ? close : undefined
            },
            Math.max(1, Math.min(30_000, deadline - Date.now())),
          )
          if (
            completedClose.status === 'rejected' ||
            completedClose.status === 'inactive' ||
            !Number.isFinite(completedClose.filledQuantity) ||
            !(Number(completedClose.filledQuantity) > 0)
          )
            throw new Error(
              'Fallback close did not establish a positive owned fill reduction; no retry was sent',
            )
        } catch (error) {
          // Stop a known cleanup order before surfacing its unresolved fill remainder.
          await cancelOwned(probe, session)
          throw error
        }
        await cancelOwned(probe, session)
      }
      throw new Error('Exact owned fill recovery did not settle within its bounded attempts')
    },
    dispose() {
      context.off('response', onResponse)
    },
  }
}
