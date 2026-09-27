export function positivePrice(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function positiveQuantity(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function quantityGreaterThan(left: number, right: number): boolean {
  return left - right > 1e-8
}

export function positiveContractId(value: string | number | undefined): number | undefined {
  const contractId = Number(value)
  return Number.isInteger(contractId) && contractId > 0 ? contractId : undefined
}

export function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || Number(value) <= 0) return undefined
  return Math.floor(Number(value))
}

export function positiveNumber(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || Number(value) <= 0) return undefined
  return Number(value)
}

export function commissionEstimate(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const amount = Number(value)
  // IBKR uses the maximum double as its unset sentinel. Zero is a valid estimate.
  return Number.isFinite(amount) && amount >= 0 && amount < 1e100 ? amount : undefined
}

export function finiteNumber(value: unknown): number | undefined {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}
