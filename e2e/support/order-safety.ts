/** Preview is a broker what-if request; all other order/position writes need authorization. */
export function isBrokerMutation(method: string, url: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return false
  const path = new URL(url, 'http://localhost:3000').pathname.replace(/\/$/u, '')
  return /^\/api\/v1\/ibkr\/(orders|positions)(?:\/|$)/u.test(path) && !path.endsWith('/preview')
}

export function ownsOrder(
  order: { id: string; parentId?: string | undefined; bracketGroupId?: string | undefined },
  ownedIds: ReadonlySet<string>,
): boolean {
  return (
    ownedIds.has(order.id) ||
    (order.parentId !== undefined && ownedIds.has(order.parentId)) ||
    (order.bracketGroupId !== undefined && ownedIds.has(order.bracketGroupId))
  )
}
