import type { OrderDraft, PlaceOrderResult } from '@ibkr-terminal/contracts'
import { expect, test } from './support/fixtures.js'
import {
  configureGtdTicket,
  openNativeTerminal,
  selectOptionContract,
} from './support/native-ticket.js'
import {
  browserHeaders,
  expectJsonOk,
  openTerminalSession,
  pollBrokerState,
  readBrokerState,
} from './support/session.js'

test('native stock ticket preserves instrument currency, acknowledges and cancels through TWS @paper', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000)
  const session = await openTerminalSession(request)
  const health = await expectJsonOk(
    await request.get('/api/v1/ibkr/health', { headers: browserHeaders }),
  )
  expect(health).toMatchObject({
    mode: 'paper',
    connectionStatus: 'connected',
  })
  await test.step('Open the native terminal', () => openNativeTerminal(page))
  const ticket = page.getByRole('region', { name: 'Order Entry' })
  let orderId: string | undefined
  try {
    const preview = await test.step('Preview a one-share stock limit order in USD', async () => {
      await ticket.getByRole('button', { name: 'LMT', exact: true }).click()
      await ticket.getByRole('textbox', { name: 'Price' }).fill('1')
      await ticket.getByRole('textbox', { name: 'Qty' }).fill('1')
      const previewResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/orders/preview') && response.request().method() === 'POST',
      )
      await ticket.getByRole('button', { name: /LMT Buy AAPL/u }).click()
      const response = await previewResponse
      expect(response.request().postDataJSON().draft.symbol.currency).toBe('USD')
      expect(await response.json()).toMatchObject({ accepted: true, source: 'broker' })
      const preview = page.getByRole('dialog', { name: 'Order Preview' })
      await expect(preview).toBeVisible()
      return preview
    })
    await test.step('Send the stock order and retain its receipt', async () => {
      const placementResponse = page.waitForResponse(
        (result) => result.url().endsWith('/orders') && result.request().method() === 'POST',
      )
      await preview.getByRole('button', { name: 'Send Order', exact: true }).click()
      const placedResponse = await placementResponse
      const placed = (await placedResponse.json()) as PlaceOrderResult
      expect(placedResponse.status(), JSON.stringify(placed)).toBe(201)
      orderId = placed.order.id
      expect(placedResponse.request().postDataJSON().draft.symbol.currency).toBe('USD')
    })
    await test.step('Verify broker acknowledgement and instrument currency', async () => {
      const order = await pollBrokerState(
        request,
        (next) => {
          const candidate = [...next.orders, ...(next.ordersHistory ?? [])].find(
            (item) => item.id === orderId,
          )
          return candidate &&
            (['working', 'pre-submitted', 'rejected'].includes(candidate.status) ||
              candidate.message?.includes('(354 req'))
            ? candidate
            : undefined
        },
        30_000,
      )
      expect
        .soft(['working', 'pre-submitted'], `Broker placement outcome: ${JSON.stringify(order)}`)
        .toContain(order.status)
      expect(order.symbol.currency).toBe('USD')
      expect(order.filledQuantity ?? 0).toBe(0)
    })
  } finally {
    if (orderId) {
      await test.step('Cancel the test stock order and await TWS confirmation', async () => {
        await expectJsonOk(
          await request.delete(`/api/v1/ibkr/orders/${orderId}`, {
            headers: session.mutationHeaders,
            data: { expectedExecutionEnvironment: 'paper' },
          }),
        )
        await pollBrokerState(
          request,
          (next) =>
            next.ordersHistory?.find(
              (order: { id: string; status: string }) =>
                order.id === orderId && order.status === 'cancelled',
            ),
          30_000,
        )
      })
    }
  }
  await expect(ticket).toContainText('Cancelled by broker.')
  await expect(ticket).toContainText('Status: order: cancelled')
  await expect(ticket).not.toContainText('Waiting for TWS acknowledgement.')
  await page.screenshot({ path: test.info().outputPath('ticket-cancelled.png') })
})

test('submits a GTD option from the native options ticket and reconciles TWS @paper', async ({
  page,
  request,
}) => {
  test.setTimeout(3 * 60_000)
  await test.step('Open the native terminal', () => openNativeTerminal(page))
  const session = await openTerminalSession(request)
  const initialState = await readBrokerState(request)
  const initialOrderIds = new Set<string>(initialState.orders.map((order) => order.id))
  let orderId: string | undefined

  try {
    const ticket = await test.step('Select an option expiring after the order deadline', () =>
      selectOptionContract(page))
    const targetDate = await test.step('Set the native GTD date and time', () =>
      configureGtdTicket(page, ticket))
    await test.step('Preview and place the option through the native ticket', async () => {
      const optionPreviewRequestPromise = page.waitForRequest(
        (candidate) => {
          if (
            candidate.method() !== 'POST' ||
            !candidate.url().endsWith('/api/v1/ibkr/orders/preview')
          ) {
            return false
          }
          const body = candidate.postDataJSON() as { draft: OrderDraft }
          return (
            body?.draft?.duration === 'gtd' &&
            body.draft.durationDateTime === targetDate.getTime() &&
            body.draft.optionLegs?.length === 1
          )
        },
        { timeout: 30_000 },
      )
      const placementResponsePromise = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' &&
          candidate.url().endsWith('/api/v1/ibkr/orders'),
      )
      await ticket.getByRole('button', { name: 'Preview & Place', exact: true }).click()
      const [optionPreviewRequest, placementResponse] = await Promise.all([
        optionPreviewRequestPromise,
        placementResponsePromise,
      ])

      const previewBody = optionPreviewRequest.postDataJSON() as { draft: OrderDraft }
      const placementBody = placementResponse.request().postDataJSON() as { draft: OrderDraft }
      expect(previewBody.draft.optionLegs).toHaveLength(1)
      const placementText = await placementResponse.text()
      if (placementResponse.status() === 201) {
        const placed = JSON.parse(placementText) as PlaceOrderResult
        orderId = placed.order.id
      }
      expect(placementResponse.status(), placementText).toBe(201)
      expect(orderId).toBeTruthy()
      expect(placementBody.draft.duration).toBe('gtd')
      expect(placementBody.draft.durationDateTime).toBe(targetDate.getTime())
      expect(placementBody.draft.optionLegs).toHaveLength(1)
    })
    await test.step('Reconcile the GTD contract and deadline with TWS', async () => {
      const acknowledged = await pollBrokerState(
        request,
        (state) => {
          const active = state.orders?.find((order) => order.id === orderId)
          if (active && ['pre-submitted', 'working'].includes(active.status)) {
            return active
          }
          const rejected = state.ordersHistory?.find(
            (order) => order.id === orderId && order.status === 'rejected',
          )
          return rejected
        },
        60_000,
      )
      expect(acknowledged.status, acknowledged.message).not.toBe('rejected')
      expect(acknowledged.duration).toBe('gtd')
      expect(acknowledged.durationDateTime).toBe(targetDate.getTime())
      expect(acknowledged.optionLegs).toHaveLength(1)
    })
  } finally {
    if (orderId !== undefined) {
      const createdOrderId = orderId
      await test.step('Cancel the test option', async () => {
        await request.delete(`/api/v1/ibkr/orders/${encodeURIComponent(createdOrderId)}`, {
          headers: session.mutationHeaders,
          data: {
            expectedExecutionEnvironment: 'paper',
            metadata: {
              operationId: `e2e-options-ticket-cleanup-${orderId}`,
              origin: 'host',
            },
          },
        })
      })
    }
  }

  if (orderId !== undefined) {
    await pollBrokerState(
      request,
      (state) => {
        const leakedOrder = state.orders?.find(
          (order) => order.id === orderId && !initialOrderIds.has(order.id),
        )
        return leakedOrder ? undefined : true
      },
      60_000,
    )
  }
})
