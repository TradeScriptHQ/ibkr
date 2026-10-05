import { IBApi } from '@stoqey/ib'
import type { GatewayConfig } from '../config.js'
import { createBridgeConfig } from '../ibkr/config.js'
import { IbkrService } from '../ibkr/ibkr-service.js'
import { PaperOwnershipJournal } from '../ibkr/paper-ownership-journal.js'
import { BrokerStateStore } from '../ibkr/state-store.js'
import { OrderIdAllocator } from '../tws/order-id-allocator.js'
import { TwsSession } from '../tws/tws-session.js'

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
  let unsubscribe: (() => void) | undefined
  return {
    ibkr,
    brokerStore,
    tws,
    retryConnection: () => tws.retryConnection(),
    connectedAccounts: () =>
      tws.snapshot().socketConnected ? tws.snapshot().managedAccountIds : undefined,
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
    stop() {
      unsubscribe?.()
      unsubscribe = undefined
      tws.disconnect()
    },
  }
}
