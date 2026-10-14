import { connectionTypeLabel, inferConnectionType } from '@ibkr-terminal/contracts'
import { EventName, IBApi } from '@stoqey/ib'
import type { GatewayConfig } from '../config.js'
import { createBridgeConfig } from '../ibkr/config.js'
import { IbkrService } from '../ibkr/ibkr-service.js'
import { PaperOwnershipJournal } from '../ibkr/paper-ownership-journal.js'
import { RequestError } from '../ibkr/request-error.js'
import { BrokerStateStore } from '../ibkr/state-store.js'
import { OrderIdAllocator } from '../tws/order-id-allocator.js'
import { TwsSession } from '../tws/tws-session.js'

const TEST_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 10_000

/** A single socket, reconciler and order allocator for one connection generation. */
export function createBrokerRuntime(
  config: GatewayConfig,
  onReadiness: () => void,
  api?: IBApi,
  ownershipDirectory?: string,
) {
  const rawApi =
    api ??
    new IBApi({
      host: config.ibkr.host,
      port: config.ibkr.port,
      clientId: config.ibkr.clientId,
      maxReqPerSec: 40,
    })
  const orderIds = new OrderIdAllocator()
  const brokerStore = new BrokerStateStore()
  const ownership =
    ownershipDirectory && config.ibkr.executionEnvironment === 'paper'
      ? new PaperOwnershipJournal(ownershipDirectory, {
          host: config.ibkr.host,
          port: config.ibkr.port,
          clientId: config.ibkr.clientId,
          environment: 'paper',
        })
      : undefined
  const ibkr = new IbkrService(createBridgeConfig(config), brokerStore, rawApi, orderIds, ownership)
  const tws = new TwsSession(config.ibkr, rawApi, orderIds)
  const label = connectionTypeLabel(
    config.ibkr.connectionType ?? inferConnectionType(config.ibkr.port),
  )
  const connectedAccounts = () =>
    tws.snapshot().socketConnected ? tws.snapshot().managedAccountIds : undefined
  let unsubscribe: (() => void) | undefined
  let pendingTest: Promise<readonly string[]> | undefined
  /** Waits for this runtime's own socket to report accounts instead of opening another client. */
  const testConnection = (): Promise<readonly string[]> => {
    const current = connectedAccounts()
    if (current?.length) return Promise.resolve([...current])
    pendingTest ??= new Promise<readonly string[]>((resolve, reject) => {
      let settled = false
      let initial = true
      let stopWatching: (() => void) | undefined
      const finish = (error?: Error, accounts?: readonly string[]) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stopWatching?.()
        pendingTest = undefined
        if (error) reject(error)
        else resolve([...(accounts ?? [])])
      }
      const timer = setTimeout(
        () =>
          finish(
            new RequestError(
              408,
              `${label} did not respond. Check the port and enable API connections in ${label}.`,
            ),
          ),
        TEST_TIMEOUT_MS,
      )
      stopWatching = tws.subscribe((snapshot) => {
        if (snapshot.socketConnected && snapshot.managedAccountIds.length > 0)
          finish(undefined, snapshot.managedAccountIds)
        else if (!initial && snapshot.state === 'error')
          finish(new RequestError(400, snapshot.message))
      })
      initial = false
      if (settled) stopWatching()
    })
    return pendingTest
  }
  return {
    ibkr,
    brokerStore,
    tws,
    retryConnection: () => tws.retryConnection(),
    connectedAccounts,
    testConnection,
    start() {
      if (unsubscribe) return
      let reconciling = false
      unsubscribe = tws.subscribe((snapshot) => {
        ibkr.setMarketDataReady(snapshot.state === 'ready')
        if (snapshot.state === 'reconciling') {
          if (!reconciling) ibkr.beginOrderReconciliation()
          reconciling = true
        } else {
          if (snapshot.state === 'ready' && reconciling) ibkr.finishOrderReconciliation()
          reconciling = false
        }
        onReadiness()
      })
      tws.connect()
    },
    /** Resolves once the transport reports its socket closed, so a replacement never overlaps it. */
    stop(): Promise<void> {
      unsubscribe?.()
      unsubscribe = undefined
      const closed = rawApi.isConnected
        ? new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer)
              rawApi.off(EventName.disconnected, done)
              resolve()
            }
            const timer = setTimeout(done, STOP_TIMEOUT_MS)
            rawApi.on(EventName.disconnected, done)
          })
        : Promise.resolve()
      tws.disconnect()
      return closed
    },
  }
}
