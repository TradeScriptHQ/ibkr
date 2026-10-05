import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import type { OptionChainResult, OptionContract } from '@ibkr-terminal/contracts'
import { request as playwrightRequest } from '@playwright/test'
import type { SymbolInfo } from '@tradescript/pro/sdk'
import { readExplicitOptionCatalog, toNativeSdkOptionContract } from './option-catalog.js'

const underlying: SymbolInfo = {
  ticker: 'SYNTH',
  brokerSymbol: 'SYNTH',
  canonicalSymbol: 'IBKR:11',
  type: 'stock',
  exchange: 'SMART',
  currency: 'USD',
}
const date = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10)

async function provider(
  options: {
    classes?: string[]
    legacyStatus?: number
    expiryDays?: number[]
    contractPatch?: Partial<OptionContract>
  } = {},
) {
  const calls: URLSearchParams[] = []
  const classes = options.classes ?? ['SYNTH-A', 'SYNTH-B']
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    calls.push(query)
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    if (!query.has('includeTradingClasses') && !query.has('tradingClass') && classes.length > 1) {
      res.statusCode = options.legacyStatus ?? 409
      res.end(JSON.stringify({ error: 'Explicit trading class required' }))
      return
    }
    const tradingClass = query.get('tradingClass') ?? classes[0]
    const expiration = query.get('expiration')
    const body: OptionChainResult = {
      underlying: 'SYNTH',
      tradingClasses: classes.map((id) => ({ id, exchange: 'SMART', multiplier: 100 })),
      ...(query.has('includeTradingClasses') || tradingClass === undefined ? {} : { tradingClass }),
      expirations: expiration
        ? [
            {
              expiration,
              contracts: (['call', 'put'] as const).map((right, index) => ({
                contract: {
                  underlying: 'SYNTH',
                  underlyingSymbolInfo: {
                    symbol: 'SYNTH',
                    canonicalSymbol: 'IBKR:11',
                    assetClass: 'stock',
                    currency: 'USD',
                    exchange: 'SMART',
                  },
                  expiration,
                  strike: 100,
                  right,
                  multiplier: 100,
                  tradingClass,
                  brokerContractId: 31 + index,
                  symbol: `SYNTH ${right}`,
                  priceStep: 0.05,
                  exchange: 'SMART',
                  route: 'SMART',
                  currency: 'USD',
                  ...options.contractPatch,
                },
              })),
            },
          ]
        : (options.expiryDays ?? [0, 1, 6]).map((days) => ({
            expiration: date(days),
            contracts: [],
          })),
    }
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Synthetic provider did not bind')
  const request = await playwrightRequest.newContext({
    baseURL: `http://127.0.0.1:${address.port}`,
  })
  return {
    request,
    calls,
    async close() {
      await request.dispose()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

const query = () => new URLSearchParams({ underlying: 'SYNTH', exchange: 'SMART', currency: 'USD' })

test('explicit provider class and future expiry load exact native rows when today is unloaded', async () => {
  const fixture = await provider()
  try {
    const result = await readExplicitOptionCatalog(fixture.request, query())
    assert.equal(result.legacyAmbiguous, true)
    assert.deepEqual(result.selection, { tradingClass: 'SYNTH-A', expiration: date(1) })
    assert.equal(result.candidate.contract.brokerContractId, 31)
    assert.deepEqual(
      fixture.calls.map((call) => [
        call.get('includeTradingClasses'),
        call.get('tradingClass'),
        call.get('expiration'),
      ]),
      [
        ['true', null, null],
        [null, null, null],
        [null, 'SYNTH-A', null],
        [null, 'SYNTH-A', date(1)],
      ],
    )
  } finally {
    await fixture.close()
  }
})

test('minimum requested expiry retains the paper harness distance from expiration', async () => {
  const fixture = await provider({ classes: ['SYNTH-A'] })
  try {
    const result = await readExplicitOptionCatalog(fixture.request, query(), {
      notBefore: Date.now() + 4 * 86400_000,
    })
    assert.equal(result.legacyAmbiguous, false)
    assert.equal(result.selection.expiration, date(6))
  } finally {
    await fixture.close()
  }
})

test('ambiguity must be explicit and preselected class or expiry cannot bypass discovery', async () => {
  const fixture = await provider({ legacyStatus: 200 })
  try {
    await assert.rejects(readExplicitOptionCatalog(fixture.request, query()), /409/)
    for (const key of ['tradingClass', 'expiration', 'includeTradingClasses']) {
      const selected = query()
      selected.set(key, 'invented')
      await assert.rejects(
        readExplicitOptionCatalog(fixture.request, selected),
        /without an assumed class or expiry/,
      )
    }
  } finally {
    await fixture.close()
  }
})

test('expired calendars cannot establish an unexpired native option contract', async () => {
  const fixture = await provider({ expiryDays: [-1, 0] })
  try {
    await assert.rejects(
      readExplicitOptionCatalog(fixture.request, query()),
      /no exact future option/,
    )
    assert.equal(
      fixture.calls.some((call) => call.has('expiration')),
      false,
    )
  } finally {
    await fixture.close()
  }
})

test('native ID, selected class and expiry must agree with the returned contract rows', async () => {
  for (const contractPatch of [
    { brokerContractId: 0 },
    { tradingClass: 'OTHER' },
    { expiration: date(-1) },
  ]) {
    const fixture = await provider({ contractPatch })
    try {
      await assert.rejects(readExplicitOptionCatalog(fixture.request, query()), /toBe/)
    } finally {
      await fixture.close()
    }
  }
})

test('stable SDK transport preserves native option terms without an undeclared class field', async () => {
  const fixture = await provider()
  try {
    const { candidate } = await readExplicitOptionCatalog(fixture.request, query())
    const contract = toNativeSdkOptionContract(candidate, underlying)
    assert.deepEqual(contract, {
      underlying: 'SYNTH',
      underlyingSymbolInfo: underlying,
      expiration: date(1),
      strike: 100,
      right: 'call',
      multiplier: 100,
      brokerContractId: 31,
      priceStep: 0.05,
      exchange: 'SMART',
      route: 'SMART',
      currency: 'USD',
      symbol: 'SYNTH call',
    })
    assert.equal('tradingClass' in contract, false)
    for (const patch of [
      { brokerContractId: undefined },
      { tradingClass: undefined },
      { priceStep: 0 },
    ])
      assert.throws(
        () =>
          toNativeSdkOptionContract({ contract: { ...candidate.contract, ...patch } }, underlying),
        /omitted exact native identity/,
      )
  } finally {
    await fixture.close()
  }
})
