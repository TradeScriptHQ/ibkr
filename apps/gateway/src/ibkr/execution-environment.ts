import { RequestError } from './request-error.js'
import type { ExecutionEnvironment, ExecutionEnvironmentBoundRequest } from './types.js'

/**
 * Executes a broker mutation only when the caller's exact environment authority
 * still matches the active broker session. ConnectionManager holds that session
 * until the operation completes, so dispatch cannot cross a UI mode change.
 */
export async function executeEnvironmentBoundMutation<T>(
  request: Partial<ExecutionEnvironmentBoundRequest>,
  backendEnvironment: ExecutionEnvironment,
  execute: () => T | Promise<T>,
): Promise<T> {
  if (request.expectedExecutionEnvironment !== backendEnvironment) {
    throw new RequestError(
      409,
      `Trading execution environment mismatch: request expected ${request.expectedExecutionEnvironment ?? 'none'}, backend is ${backendEnvironment}.`,
    )
  }
  return await execute()
}
