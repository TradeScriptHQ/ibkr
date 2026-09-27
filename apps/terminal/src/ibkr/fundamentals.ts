import type { BrokerInstrumentDetails } from '@ibkr-terminal/contracts'
import type {
  InstrumentDetails,
  InstrumentDetailsRequest,
  InstrumentFundamentalField,
} from '@tradescript/pro/sdk'
import { get } from './datafeed-requests.js'

export async function loadInstrumentDetails(
  baseUrl: string,
  { symbol }: InstrumentDetailsRequest,
): Promise<InstrumentDetails> {
  const params = new URLSearchParams({ symbol: symbol.brokerSymbol ?? symbol.ticker })
  if (symbol.exchange) params.set('exchange', symbol.exchange)
  if (symbol.listedExchange) params.set('primaryExchange', symbol.listedExchange)
  if (symbol.currency) params.set('currency', symbol.currency)
  if (symbol.type) params.set('assetClass', symbol.type)
  const details = await get<BrokerInstrumentDetails>(baseUrl, `/instrument-details?${params}`)
  const section = { id: 'instrument', label: 'Instrument & business' }
  const fields: InstrumentFundamentalField[] = [
    { id: 'name', label: 'Name', value: details.name ?? null },
    { id: 'exchange', label: 'Listed exchange', value: details.symbol.primaryExchange ?? null },
    { id: 'currency', label: 'Currency', value: details.symbol.currency ?? null },
    { id: 'industry', label: 'Industry', value: details.industry ?? null },
    { id: 'category', label: 'Category', value: details.category ?? null },
    { id: 'subcategory', label: 'Subcategory', value: details.subcategory ?? null },
    { id: 'min-tick', label: 'Minimum tick', value: details.minTick ?? null },
  ]
  return {
    symbol,
    ...(details.name ? { name: details.name } : {}),
    ...(details.industry ? { industry: details.industry } : {}),
    fundamentalFields: fields.map((field) => ({ ...field, section })),
    metadata: { provider: details.source },
  }
}
