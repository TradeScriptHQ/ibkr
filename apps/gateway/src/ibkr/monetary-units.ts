import type { ContractDetails } from '@stoqey/ib'

/** Native alignment metadata is not a declaration of quote-price currency units. */
export function nativeMonetaryUnits(details: ContractDetails): {
  monetaryValueAvailable?: boolean
  monetaryValueUnavailableReason?: string
} {
  if (details.priceMagnifier !== 1) {
    return {
      monetaryValueAvailable: false,
      monetaryValueUnavailableReason:
        'IBKR quote monetary units are unavailable for this contract. The native price magnifier does not establish a currency conversion.',
    }
  }
  return {}
}
