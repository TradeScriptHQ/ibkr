export class GatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'GatewayRequestError'
  }
}

export async function gatewayRequest<T = unknown>(
  baseUrl: string,
  path: string,
  init: { method?: string | undefined; body?: unknown | undefined } = {},
  csrfToken?: string,
  connectionGeneration?: string,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'x-tradescript-client': 'terminal-v1',
      ...(connectionGeneration ? { 'x-tradescript-connection': connectionGeneration } : {}),
      ...(init.body !== undefined
        ? {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'x-tradescript-csrf': csrfToken } : {}),
          }
        : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      | { error?: string | { message?: string | undefined } | undefined }
      | undefined
    const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message
    throw new GatewayRequestError(
      response.status,
      path,
      message ?? `IBKR bridge request failed: ${response.status}`,
    )
  }
  return response.json() as Promise<T>
}
