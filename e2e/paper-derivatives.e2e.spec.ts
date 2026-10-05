import type { MarketSessionInfo, OptionChainResult } from '@ibkr-terminal/contracts'
import type { TradingOrderDraft } from '@tradescript/pro/sdk'
import { expect, test } from './support/fixtures.js'
import { descriptor, discover, queryFor, select } from './support/instrument-contracts.js'
import { readExplicitOptionCatalog, toNativeSdkOptionContract } from './support/option-catalog.js'
import {
  accepted,
  cleanUp,
  modifyLimit,
  positionQuantities,
  readState,
  submit,
  verifyMarketFill,
} from './support/paper-orders.js'
import { browserHeaders, expectJsonOk, openTerminalSession } from './support/session.js'

test.beforeEach(async ({ request }) => {
  await openTerminalSession(request)
})

for (const instrument of [
  {
    root: 'SPX',
    assetClass: 'index',
    exchange: 'CBOE',
    label: 'Indices',
    securityType: 'OPT',
    multiplier: 100,
  },
  {
    root: 'MES',
    assetClass: 'futures',
    exchange: 'CME',
    label: 'Futures',
    securityType: 'FOP',
    multiplier: 5,
  },
]) {
  test(`${instrument.root} options: native API keeps the exact underlying and option contract`, async ({
    page,
    request,
  }) => {
    const selected = (
      await discover(request, instrument.root, instrument.assetClass, instrument.exchange)
    )[0]
    if (!selected?.brokerSymbol || !selected.currency)
      throw new Error('TWS omitted the exact derivative underlying identity.')
    const query = new URLSearchParams({
      underlying: selected.brokerSymbol,
      underlyingAssetClass: instrument.assetClass,
      underlyingExchange: instrument.exchange,
      currency: selected.currency,
      maxQuoteContracts: '2',
      quoteWindowRows: '2',
    })
    const { candidate, legacyAmbiguous } = await readExplicitOptionCatalog(request, query)
    const first = candidate.contract
    test.info().annotations.push({
      type: 'option-api-boundary',
      description: `Exact native API catalog inspected; legacy class ambiguity: ${legacyAmbiguous}. Underlying selection is a smoke check; installed SDK option-class selection/rendering remains unqualified under H13.`,
    })
    expect(first.underlyingSymbolInfo.assetClass).toBe(instrument.assetClass)
    expect(first.underlyingSymbolInfo.canonicalSymbol).toBe(selected.canonicalSymbol)
    expect(first.multiplier).toBe(instrument.multiplier)
    expect(first.priceStep).toBeGreaterThan(0)
    if (!first.exchange) throw new Error('TWS omitted the native option exchange.')
    const native = await expectJsonOk<
      Array<{ symbol: { contractIdentity: { securityType: string; conId: number } } }>
    >(
      await request.get(
        `/api/v1/ibkr/contracts?${new URLSearchParams({ symbol: instrument.root, securityType: instrument.securityType, exchange: first.exchange, conId: String(first.brokerContractId) })}`,
        { headers: browserHeaders },
      ),
    )
    expect(native[0]?.symbol.contractIdentity).toMatchObject({
      securityType: instrument.securityType,
      conId: Number(first.brokerContractId),
      tradingClass: first.tradingClass,
      multiplier: first.multiplier,
    })
    await select(page, instrument.root, instrument.label, selected)
  })
}

for (const instrument of [
  { root: 'SPX', assetClass: 'index', exchange: 'CBOE', label: 'Indices' },
  { root: 'MES', assetClass: 'futures', exchange: 'CME', label: 'Futures' },
]) {
  for (const flow of ['lifecycle', 'execution'] as const) {
    test(`${instrument.root} options: paper ${flow} through SDK and exact broker readback @paper`, async ({
      page,
      request,
    }) => {
      test.setTimeout(180_000)
      const selected = (
        await discover(request, instrument.root, instrument.assetClass, instrument.exchange)
      )[0]!
      const symbol = descriptor(selected)
      const session = await expectJsonOk<MarketSessionInfo>(
        await request.get(`/api/v1/ibkr/sessions?${queryFor(symbol)}`, { headers: browserHeaders }),
      )
      test.skip(
        !session.upcoming.some(
          (window) =>
            window.opensAt <= Date.now() &&
            window.closesAt > Date.now() &&
            ['regular', 'pre-market', 'post-market', 'extended'].includes(window.state),
        ),
        `IBKR ${instrument.root} session is ${session.currentState}; option lifecycle and cleanup require an open venue`,
      )
      const query = new URLSearchParams({
        underlying: selected.brokerSymbol!,
        underlyingAssetClass: instrument.assetClass,
        underlyingExchange: instrument.exchange,
        currency: selected.currency!,
        maxQuoteContracts: '16',
        quoteWindowRows: '8',
      })
      const { selection } = await readExplicitOptionCatalog(request, query)
      query.set('tradingClass', selection.tradingClass)
      query.set('expiration', selection.expiration)
      test.info().annotations.push({
        type: 'option-api-boundary',
        description:
          'Programmatic SDK draft preserves a provider-qualified native ID and tuple; installed SDK widget class selection/rendering remains unqualified under H13.',
      })
      let entries: OptionChainResult['expirations'][number]['contracts'] = []
      await expect
        .poll(
          async () => {
            const chain = await expectJsonOk<OptionChainResult>(
              await request.get(`/api/v1/ibkr/options/chain?${query}`, {
                headers: browserHeaders,
                timeout: 90_000,
              }),
            )
            entries = chain.expirations.flatMap((expiry) => expiry.contracts)
            return entries.some(
              (entry) =>
                entry.contract.right === 'call' && Number(entry.bid) > 0 && Number(entry.ask) > 0,
            )
          },
          { timeout: 45_000 },
        )
        .toBe(true)
      const selectedOption = entries.find(
        (entry) =>
          entry.contract.right === 'call' && Number(entry.bid) > 0 && Number(entry.ask) > 0,
      )!
      const contract = selectedOption.contract
      if (!contract.priceStep || !contract.brokerContractId)
        throw new Error('Missing broker option identity or price increment')
      const price = Number(
        (
          Math.max(2, Math.floor((selectedOption.bid! * 0.95) / contract.priceStep)) *
          contract.priceStep
        ).toFixed(6),
      )
      const draft: TradingOrderDraft = {
        symbol,
        side: 'buy',
        type: flow === 'execution' ? 'market' : 'limit',
        quantity: 1,
        duration: { type: 'day' },
        ...(flow === 'execution' ? {} : { price }),
        optionLegs: [
          {
            contract: toNativeSdkOptionContract(selectedOption, symbol),
            side: 'buy',
            positionEffect: 'open',
            quantity: 1,
            ratio: 1,
            price: selectedOption.ask!,
          },
        ],
      }
      await select(page, instrument.root, instrument.label, selected)
      const baseline = positionQuantities(await readState(request))
      let id: string | undefined
      try {
        id = await submit(page, draft)
        const family = await accepted(request, id, 1)
        expect(family[0]?.symbol.contractIdentity?.conId).toBe(contract.brokerContractId)
        if (flow === 'execution') await verifyMarketFill(request, id)
        else
          await modifyLimit(
            page,
            request,
            id,
            Number((price - contract.priceStep).toFixed(6)),
            symbol,
          )
      } finally {
        if (id) await cleanUp(page, request, id, draft)
        await expect
          .poll(async () => positionQuantities(await readState(request)), { timeout: 30_000 })
          .toEqual(baseline)
      }
    })
  }
}
