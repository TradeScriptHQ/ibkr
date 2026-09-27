import type { Order, OrderDraft, OrderSide } from './types.js'

export function exitChildDrafts(draft: OrderDraft): Array<{
  draft: OrderDraft
  leg: 'take-profit' | 'stop-loss'
  levelId: string
  paired: boolean
}> {
  const side: OrderSide = draft.side === 'buy' ? 'sell' : 'buy'
  return (draft.exits?.levels ?? []).flatMap((level) => {
    const common = {
      accountId: draft.accountId,
      symbol: draft.symbol,
      side,
      duration: draft.duration,
      durationDateTime: draft.durationDateTime,
      quantity: level.quantity,
    }
    const paired = Boolean(level.takeProfit && level.stopLoss)
    const children: Array<{
      draft: OrderDraft
      leg: 'take-profit' | 'stop-loss'
      levelId: string
      paired: boolean
    }> = []
    if (level.takeProfit) {
      children.push({
        draft: {
          ...common,
          type: 'limit',
          limitPrice: level.takeProfit.price,
          outsideRth: draft.takeProfitOutsideRth,
        },
        leg: 'take-profit',
        levelId: level.id,
        paired,
      })
    }
    if (level.stopLoss?.kind === 'fixed') {
      children.push({
        draft: {
          ...common,
          type: level.stopLoss.limitPrice ? 'stop-limit' : 'stop',
          stopPrice: level.stopLoss.triggerPrice,
          limitPrice: level.stopLoss.limitPrice,
        },
        leg: 'stop-loss',
        levelId: level.id,
        paired,
      })
    } else if (level.stopLoss?.kind === 'trailing') {
      children.push({
        draft: { ...common, type: 'trailing-stop', trailingStopPips: level.stopLoss.trailingPips },
        leg: 'stop-loss',
        levelId: level.id,
        paired,
      })
    }
    return children
  })
}

export function toExitChildOrder(
  child: OrderDraft,
  rootDraft: OrderDraft,
  parent: Order,
  brokerOrderId: number,
  leg: 'take-profit' | 'stop-loss',
  timestamp: string,
  ocaGroup?: string,
): Order {
  const childType =
    leg === 'take-profit'
      ? 'limit'
      : child.type === 'stop-limit'
        ? 'stop-limit'
        : child.type === 'trailing-stop'
          ? 'trailing-stop'
          : 'stop'
  return {
    ...child,
    accountId: parent.accountId,
    symbol: rootDraft.symbol,
    id: String(brokerOrderId),
    brokerOrderId,
    type: childType,
    status: 'placing',
    submittedAt: timestamp,
    updatedAt: timestamp,
    remainingQuantity: child.quantity,
    parentId: parent.id,
    parentType: 'order',
    bracketGroupId: parent.id,
    ocaGroup,
    ocaType: ocaGroup ? 2 : undefined,
  }
}
