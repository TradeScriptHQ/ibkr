import type { Page } from '@playwright/test'
import { loadCryptoContract } from '../support/crypto-orders.js'
import { expect, test } from '../support/fixtures.js'
import { openTerminalSession, readBrokerState } from '../support/session.js'

// Native contract identities use the paper gateway. Monetary availability, FX
// conversion and preview responses are synthetic; financial writes never reach TWS.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

async function interceptOrderRequests(page: Page, accountCurrency: string) {
  const requests = { previews: 0, writes: [] as string[] }
  await page.route(/\/api\/v1\/ibkr\/orders(?:\/|\?|$)/u, (route) => {
    const request = route.request()
    if (request.method() === 'GET') return route.fallback()
    const pathname = new URL(request.url()).pathname
    if (request.method() === 'POST' && pathname === '/api/v1/ibkr/orders/preview') {
      requests.previews += 1
      return route.fulfill({
        json: {
          accepted: true,
          source: 'broker',
          estimatedCommission: 0.25,
          commissionCurrency: 'USD',
          confirmId: 'synthetic-ticket-preview',
        },
      })
    }
    requests.writes.push(`${request.method()} ${pathname}`)
    return route.abort('blockedbyclient')
  })
  await page.route('**/api/v1/ibkr/sessions?*', async (route) => {
    const response = await route.fetch({
      headers: {
        ...(await route.request().allHeaders()),
        origin: new URL(route.request().url()).origin,
        'sec-fetch-site': 'same-origin',
        'x-tradescript-client': 'terminal-v1',
      },
    })
    expect(response.status()).toBe(200)
    const session = await response.json()
    await route.fulfill({
      response,
      json: {
        ...session,
        metadata: { ...session.metadata, monetaryValueAvailable: true },
      },
    })
  })
  await page.route('**/api/v1/ibkr/accounts/*/currency-conversion?*', (route) =>
    route.fulfill({
      json: {
        fromCurrency: new URL(route.request().url()).searchParams.get('fromCurrency'),
        toCurrency: accountCurrency,
        rate: 1,
        asOf: Date.now(),
        source: 'ibkr-live-fx:synthetic-order-preview-fixture',
      },
    }),
  )
  return requests
}

for (const ticker of ['AAPL', 'BTC'] as const) {
  test(`${ticker}: ticket previews only after Buy, including after editing and cancelling`, async ({
    page,
    request,
  }) => {
    await openTerminalSession(request)
    const state = await readBrokerState(request)
    const accountCurrency = state.accounts.find(
      (account) => account.id === state.activeAccountId,
    )?.currency
    if (!accountCurrency) throw new Error('The paper account has no currency')
    if (ticker === 'BTC') await loadCryptoContract(request, ticker)
    const requests = await interceptOrderRequests(page, accountCurrency)
    await page.goto('/')
    await expect(page.getByRole('region', { name: 'IBKR Chart', exact: true })).toBeVisible()
    if (ticker === 'BTC') {
      await page.getByRole('button', { name: /^Change symbol /u }).click()
      await page.getByPlaceholder('Symbol', { exact: true }).fill(ticker)
      await page.getByRole('button', { name: 'PAXOS', exact: true }).click()
      await page.getByPlaceholder('Symbol', { exact: true }).press('Enter')
    }
    const ticket = page.getByRole('region', { name: 'Order Entry', exact: true })
    await ticket.getByRole('button', { name: 'MKT', exact: true }).click()
    const buy = ticket.getByRole('button', { name: `MKT Buy ${ticker}`, exact: true })
    await expect(buy).toBeEnabled()
    // Exceed the SDK's 350 ms debounce while the valid ticket remains open.
    await page.waitForTimeout(700)
    expect(requests.previews).toBe(0)

    const quantity = ticket.getByRole('textbox', {
      name: ticker === 'BTC' ? 'Cash amount (USD)' : 'Qty',
      exact: true,
    })
    await quantity.fill(ticker === 'BTC' ? '25' : '2')
    await quantity.press('Tab')
    await expect(buy).toBeEnabled()
    await page.waitForTimeout(700)
    expect(requests.previews).toBe(0)

    const preview = page.getByRole('dialog', { name: 'Order Preview', exact: true })
    await buy.click()
    await expect(preview).toBeVisible()
    expect(requests.previews).toBe(1)
    expect(requests.writes).toEqual([])
    await preview.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await expect(preview).toHaveCount(0)
    await quantity.fill(ticker === 'BTC' ? '30' : '3')
    await quantity.press('Tab')
    await page.waitForTimeout(700)
    expect(requests.previews).toBe(1)

    await buy.click()
    await expect(preview).toBeVisible()
    expect(requests.previews).toBe(2)
    await preview.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await page.close()
    expect(requests.writes).toEqual([])
  })
}
