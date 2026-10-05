import type { BrokerSymbol, ContractPipDefinition } from './types.js'

/** Explicit native record, independently verified against the IBKR contract catalog.
 * IBKR's glossary defines the quoted JPY pip as 0.01; this is never an alias rule.
 */
export const PROVIDER_PIP_DEFINITIONS: readonly ContractPipDefinition[] = Object.freeze([
  Object.freeze({
    conId: 15016059,
    securityType: 'CASH',
    currency: 'JPY',
    pipSize: 0.01,
    unit: 'quote-price-per-pip',
    source: 'provider-specification',
    reference: 'https://www.interactivebrokers.com/campus/glossary-terms/pip/',
  }),
])

/** Server-owned contract facts. No order draft or tick schedule may define a pip unit. */
export class ContractPipRegistry {
  private readonly definitions: ReadonlyMap<number, Readonly<ContractPipDefinition>>

  constructor(definitions: readonly ContractPipDefinition[] = []) {
    const entries = new Map<number, Readonly<ContractPipDefinition>>()
    for (const definition of definitions) {
      if (
        !Number.isSafeInteger(definition.conId) ||
        definition.conId <= 0 ||
        !Number.isFinite(definition.pipSize) ||
        definition.pipSize <= 0 ||
        definition.unit !== 'quote-price-per-pip' ||
        !['provider-specification', 'approved-contract-catalog'].includes(definition.source) ||
        !definition.securityType.trim() ||
        !definition.currency.trim() ||
        !definition.reference.trim()
      )
        throw new Error(
          'An approved pip definition requires exact native identity, a positive quote-price unit and a source reference.',
        )
      if (entries.has(definition.conId)) throw new Error('Duplicate native pip definition.')
      entries.set(
        definition.conId,
        Object.freeze({
          ...definition,
          securityType: definition.securityType.toUpperCase(),
          currency: definition.currency.toUpperCase(),
        }),
      )
    }
    this.definitions = entries
  }

  forSymbol(symbol: BrokerSymbol): Readonly<ContractPipDefinition> | undefined {
    const identity = symbol.contractIdentity
    const canonical = /^IBKR:(\d+)$/u.exec(symbol.canonicalSymbol ?? symbol.symbol)
    const nativeId = canonical ? Number(canonical[1]) : undefined
    const conId = identity?.conId ?? nativeId
    if (
      !conId ||
      (nativeId !== undefined && identity?.conId !== undefined && nativeId !== identity.conId)
    )
      return undefined
    const definition = this.definitions.get(conId)
    const declaredSecurityType =
      identity?.securityType ??
      (
        {
          stock: 'STK',
          futures: 'FUT',
          forex: 'CASH',
          option: 'OPT',
          'futures-option': 'FOP',
          warrant: 'WAR',
          commodity: 'CMDTY',
          cfd: 'CFD',
        } as Record<string, string>
      )[symbol.assetClass ?? '']
    if (
      !definition ||
      declaredSecurityType?.toUpperCase() !== definition.securityType ||
      symbol.currency?.toUpperCase() !== definition.currency
    )
      return undefined
    return definition
  }
}

let activeRegistry = new ContractPipRegistry(PROVIDER_PIP_DEFINITIONS)

/** Called only from the server's validated configuration path, never an HTTP draft. */
export function installContractPipDefinitions(definitions: readonly ContractPipDefinition[]): void {
  activeRegistry = new ContractPipRegistry([...PROVIDER_PIP_DEFINITIONS, ...definitions])
}

export function authoritativePipDefinition(
  symbol: BrokerSymbol,
): Readonly<ContractPipDefinition> | undefined {
  return activeRegistry.forSymbol(symbol)
}

export function pipDistanceInPrice(symbol: BrokerSymbol, pips: number): number | undefined {
  const definition = authoritativePipDefinition(symbol)
  const amount =
    definition && Number.isFinite(pips) && pips > 0 ? pips * definition.pipSize : undefined
  return amount !== undefined && Number.isFinite(amount) && amount > 0 ? amount : undefined
}
