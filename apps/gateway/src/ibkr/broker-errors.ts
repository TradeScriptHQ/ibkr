import { ErrorCode, isNonFatalError } from '@stoqey/ib'
import { RequestError } from './request-error.js'

export function isIbRequestWarning(error: Error, code?: number, requestId?: number): boolean {
  if (code == null) return false
  if (isNonFatalError(code as ErrorCode, error)) return true
  return (
    requestId != null && requestId !== ErrorCode.NO_VALID_ID && code !== ErrorCode.NOT_CONNECTED
  )
}

export function isIbOrderWarning(code?: number): boolean {
  return code === 354 || code === 399 || code === 2109 || code === 2137
}

export function isIbOrderCancellation(code: number | undefined, message: string): boolean {
  return code === 202 || /order\s+cancell?ed/i.test(message)
}

export function normalizeIbkrMessage(message: string): string {
  return message
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseIbkrPriceControlRejection(
  message: string,
): { boundaryPrice: number; referencePrice: number } | undefined {
  const boundary = /limit price at or more aggressive than\s+([0-9]+(?:\.[0-9]+)?)/i.exec(
    message,
  )?.[1]
  const reference = /current market price of\s+([0-9]+(?:\.[0-9]+)?)/i.exec(message)?.[1]
  if (boundary === undefined || reference === undefined) return undefined
  const boundaryPrice = Number(boundary)
  const referencePrice = Number(reference)
  if (!Number.isFinite(boundaryPrice) || !Number.isFinite(referencePrice)) return undefined
  return { boundaryPrice, referencePrice }
}

export function isIbMarketDataWarning(code?: number): boolean {
  return (
    code === 354 ||
    code === 10089 ||
    code === 10090 ||
    code === 10091 ||
    code === 10167 ||
    code === 10168
  )
}

export function isOrderPreviewUnavailableError(error: unknown): boolean {
  return error instanceof RequestError && error.statusCode === 504
}
