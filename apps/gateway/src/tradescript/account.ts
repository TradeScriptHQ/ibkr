import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { RequestError } from '../ibkr/request-error.js'
import type { Licensing } from './licensing.js'
import { PrivateStore } from './private-store.js'

const AuthConfigurationSchema = z.object({
  supabaseURL: z.url(),
  publishableKey: z.string().min(1),
})
const SessionSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().int().positive(),
  user: z.object({
    id: z.uuid(),
    email: z.email(),
    factors: z
      .array(z.object({ id: z.uuid(), status: z.string(), factor_type: z.string() }))
      .optional(),
  }),
})
const TokenResponseSchema = SessionSchema.omit({ expires_at: true }).extend({
  expires_in: z.number().int().positive(),
})
const AccountSchema = z.object({ id: z.uuid(), email: z.email() })
const LicenseSchema = z.object({
  status: z.enum(['not-provisioned', 'pending', 'active', 'expired', 'inactive']),
  kind: z.enum(['trial', 'paid']).nullable().optional(),
  plan: z.string().nullable().optional(),
  trialStartedAt: z.string().nullable().optional(),
  trialEndsAt: z.string().nullable().optional(),
  trialDays: z.number().int().positive(),
  accessEndsAt: z.string().nullable().optional(),
  credentialsAvailable: z.boolean(),
})
const LicenseStatusSchema = z.object({ account: AccountSchema, license: LicenseSchema })
const RuntimeReadbackSchema = LicenseStatusSchema.extend({
  authorization: z.object({
    credentialId: z.string().min(1),
    runtimeCredential: z.string().min(1),
  }),
})

export type TerminalLicense = z.infer<typeof LicenseSchema>
export interface TradeScriptAccountSnapshot {
  state: 'signed-out' | 'authenticating' | 'signed-in' | 'mfa-required' | 'error'
  account?: z.infer<typeof AccountSchema>
  license?: TerminalLicense
  message?: string
}

export class AccountSessionStore extends PrivateStore<z.infer<typeof SessionSchema>> {
  constructor(path: string, key?: Buffer) {
    super(path, SessionSchema, key)
  }
}

/** Native owns PKCE and all tokens. Only the one-time code crosses the browser callback. */
export class TradeScriptAccount {
  readonly #fetch: typeof fetch
  readonly #console: URL
  #session: z.infer<typeof SessionSchema> | undefined
  #authConfiguration: z.infer<typeof AuthConfigurationSchema> | undefined
  #snapshot: TradeScriptAccountSnapshot = { state: 'signed-out' }
  #callback: Server | undefined
  #callbackTimer: NodeJS.Timeout | undefined
  #generation = 0
  #syncing: Promise<TradeScriptAccountSnapshot> | undefined
  #initialLoginPending = false

  constructor(
    private readonly store: AccountSessionStore,
    private readonly licensing: Pick<Licensing, 'activate' | 'logout'>,
    options: { consoleURL?: string; fetch?: typeof fetch } = {},
  ) {
    this.#fetch = options.fetch ?? fetch
    this.#console = new URL(options.consoleURL ?? 'https://console.tradescript.dev')
    if (
      this.#console.username ||
      this.#console.password ||
      (this.#console.protocol !== 'https:' &&
        !(
          this.#console.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(this.#console.hostname)
        ))
    )
      throw new Error('TradeScript Console must use HTTPS or a literal development loopback host.')
    try {
      this.#session = store.read()
      if (this.#session) this.#snapshot = { state: 'signed-in' }
    } catch {
      this.#snapshot = {
        state: 'error',
        message: 'Saved account access could not be read. Log out and sign in again.',
      }
    }
  }

  snapshot(): TradeScriptAccountSnapshot {
    return structuredClone(this.#snapshot)
  }

  purchaseURL(): string {
    const url = new URL('/login', this.#console)
    url.searchParams.set('mode', 'trader')
    url.searchParams.set('plan', 'individual')
    return url.toString()
  }

  async configuration() {
    if (!this.#authConfiguration) {
      const response = await this.#fetch(new URL('/api/v1/auth/configuration', this.#console), {
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok)
        throw new RequestError(503, 'TradeScript sign-in is unavailable. Try again shortly.')
      const config = AuthConfigurationSchema.parse(await response.json())
      const url = new URL(config.supabaseURL)
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Invalid account authentication configuration.')
      this.#authConfiguration = config
    }
    return this.#authConfiguration
  }

  async login(): Promise<{ url: string }> {
    if (this.#session)
      throw new RequestError(409, 'Log out before signing into another TradeScript account.')
    if (this.#syncing) throw new RequestError(409, 'License syncing is in progress. Please wait.')
    this.cancelLogin()
    const generation = ++this.#generation
    await this.configuration()
    if (generation !== this.#generation) throw new RequestError(409, 'Sign-in was cancelled.')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(32).toString('base64url')
    let consumed = false
    const server = createServer((request, response) => {
      const port = (server.address() as AddressInfo).port
      const base = `http://127.0.0.1:${port}`
      let url: URL
      try {
        url = new URL(request.url ?? '/', base)
      } catch {
        response
          .writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
          .end('This sign-in callback is invalid. Return to TradeScript Terminal.')
        return
      }
      const returnedState = url.searchParams.get('state') ?? ''
      const returnedBytes = Buffer.from(returnedState)
      const stateBytes = Buffer.from(state)
      const validState =
        /^[A-Za-z0-9_-]{43}$/u.test(returnedState) &&
        returnedBytes.length === stateBytes.length &&
        timingSafeEqual(returnedBytes, stateBytes)
      if (
        request.method !== 'GET' ||
        request.headers.host !== `127.0.0.1:${port}` ||
        url.origin !== base ||
        url.pathname !== '/callback' ||
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.getAll('code').length > 1 ||
        !validState ||
        consumed
      ) {
        response
          .writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
          .end('This sign-in callback is invalid. Return to TradeScript Terminal.')
        return
      }
      consumed = true
      const code = url.searchParams.get('code')
      response.writeHead(200, {
        'content-type': 'text/html',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'referrer-policy': 'no-referrer',
      })
      response.end(
        '<!doctype html><title>TradeScript Terminal</title><main style="font:18px system-ui;padding:48px">Sign-in received. Return to TradeScript Terminal. You can close this tab.</main>',
      )
      this.cancelLogin()
      void this.finishLogin(code, verifier, generation).catch(() => undefined)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    if (generation !== this.#generation) {
      server.close()
      throw new RequestError(409, 'Sign-in was cancelled.')
    }
    this.#callback = server
    this.#snapshot = { state: 'authenticating', message: 'Finish signing in in your browser.' }
    this.#callbackTimer = setTimeout(
      () => {
        if (generation !== this.#generation) return
        ++this.#generation
        this.cancelLogin()
        this.#snapshot = { state: 'signed-out', message: 'Sign-in timed out. Try again.' }
      },
      5 * 60 * 1000,
    )
    this.#callbackTimer.unref()
    const url = new URL('/login', this.#console)
    url.searchParams.set('mode', 'trader')
    url.searchParams.set('native', '1')
    url.searchParams.set('callback_port', String((server.address() as AddressInfo).port))
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    return { url: url.toString() }
  }

  private async finishLogin(code: string | null, verifier: string, generation: number) {
    try {
      if (!code || code.length > 2048) throw new Error('Sign-in was not completed. Try again.')
      const config = await this.configuration()
      const response = await this.#fetch(
        new URL('/auth/v1/token?grant_type=pkce', config.supabaseURL),
        {
          method: 'POST',
          headers: { apikey: config.publishableKey, 'content-type': 'application/json' },
          body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
          signal: AbortSignal.timeout(15000),
        },
      )
      if (!response.ok) throw new Error('Sign-in could not be completed. Try again.')
      const token = TokenResponseSchema.parse(await response.json())
      if (generation !== this.#generation) return
      this.#session = { ...token, expires_at: Math.floor(Date.now() / 1000) + token.expires_in }
      this.store.write(this.#session)
      this.#snapshot = { state: 'signed-in', message: 'Checking your TradeScript license…' }
      this.#initialLoginPending = true
      await this.sync(undefined, true)
    } catch (error) {
      if (generation !== this.#generation) return
      this.#snapshot = {
        ...this.#snapshot,
        state:
          this.#snapshot.state === 'mfa-required'
            ? 'mfa-required'
            : this.#session
              ? 'signed-in'
              : 'error',
        message:
          error instanceof RequestError
            ? error.message
            : 'Sign-in could not be completed. Try again.',
      }
    }
  }

  private async accessToken(generation: number): Promise<string> {
    const session = this.#session
    if (!session) throw new RequestError(401, 'Log in to TradeScript before syncing your license.')
    if (session.expires_at > Date.now() / 1000 + 60) return session.access_token
    const config = await this.configuration()
    const response = await this.#fetch(
      new URL('/auth/v1/token?grant_type=refresh_token', config.supabaseURL),
      {
        method: 'POST',
        headers: { apikey: config.publishableKey, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
        signal: AbortSignal.timeout(15000),
      },
    )
    if (!response.ok)
      throw new RequestError(
        401,
        'Your TradeScript sign-in has expired. Log out and sign in again.',
      )
    const token = TokenResponseSchema.parse(await response.json())
    if (token.user.id !== session.user.id)
      throw new RequestError(403, 'The account session changed. Log out and sign in again.')
    if (generation !== this.#generation)
      throw new RequestError(409, 'License syncing was cancelled.')
    this.#session = { ...token, expires_at: Math.floor(Date.now() / 1000) + token.expires_in }
    this.store.write(this.#session)
    return token.access_token
  }

  sync(expectedAccountId?: string, initialLogin = false): Promise<TradeScriptAccountSnapshot> {
    if (this.#syncing)
      return this.#syncing.then((snapshot) => {
        if (expectedAccountId && snapshot.account?.id !== expectedAccountId) {
          const message = `This app is signed in as ${snapshot.account?.email ?? 'another account'}. Log out and sign in to the account used in the console.`
          this.#snapshot = { ...this.#snapshot, message }
          throw new RequestError(409, message)
        }
        return snapshot
      })
    const generation = this.#generation
    this.#syncing = this.syncAccount(generation, expectedAccountId, initialLogin)
      .catch((error) => {
        if (generation === this.#generation)
          this.#snapshot = {
            ...this.#snapshot,
            message:
              error instanceof RequestError
                ? error.message
                : 'Could not sync your TradeScript license. Try again.',
          }
        throw error
      })
      .finally(() => {
        this.#syncing = undefined
      })
    return this.#syncing
  }

  async verifyMfa(input: unknown): Promise<TradeScriptAccountSnapshot> {
    const code = z
      .string()
      .regex(/^\d{6}$/u)
      .safeParse(input)
    if (!code.success)
      throw new RequestError(400, 'Enter the six-digit code from your authenticator app.')
    if (this.#syncing) throw new RequestError(409, 'License syncing is in progress. Please wait.')
    const generation = this.#generation
    const token = await this.accessToken(generation)
    const session = this.#session
    const factor = session?.user.factors?.find(
      (value) => value.status === 'verified' && value.factor_type === 'totp',
    )
    if (!session || !factor)
      throw new RequestError(
        400,
        'No verified authenticator is available. Manage two-step verification in TradeScript Console.',
      )
    const config = await this.configuration()
    const request = async (path: string, body: object) => {
      const response = await this.#fetch(new URL(path, config.supabaseURL), {
        method: 'POST',
        headers: {
          apikey: config.publishableKey,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok)
        throw new RequestError(
          400,
          'The authenticator code could not be verified. Try a current code.',
        )
      const value = await response.json()
      if (generation !== this.#generation) throw new RequestError(409, 'Sign-in was cancelled.')
      return value
    }
    const challenge = z
      .object({ id: z.uuid() })
      .parse(await request(`/auth/v1/factors/${factor.id}/challenge`, {}))
    const upgraded = TokenResponseSchema.parse(
      await request(`/auth/v1/factors/${factor.id}/verify`, {
        challenge_id: challenge.id,
        code: code.data,
      }),
    )
    if (upgraded.user.id !== session.user.id)
      throw new RequestError(403, 'The account session changed. Please sign in again.')
    this.#session = { ...upgraded, expires_at: Math.floor(Date.now() / 1000) + upgraded.expires_in }
    this.store.write(this.#session)
    this.#snapshot = {
      state: 'signed-in',
      message: 'Two-step verification completed. Checking your license…',
    }
    return this.sync(undefined, this.#initialLoginPending)
  }

  private async syncAccount(generation: number, expectedAccountId?: string, initialLogin = false) {
    const token = await this.accessToken(generation)
    const request = async (method: 'GET' | 'POST', path: string, body = {}) => {
      const response = await this.#fetch(new URL(path, this.#console), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        const value: unknown = await response.json().catch(() => undefined)
        const parsed = z
          .object({
            error: z.object({ message: z.string().min(1).max(2048), code: z.string().optional() }),
          })
          .safeParse(value)
        if (parsed.success && parsed.data.error.code === 'mfa_required')
          this.#snapshot = {
            ...this.#snapshot,
            state: 'mfa-required',
            message: parsed.data.error.message,
          }
        throw new RequestError(
          response.status,
          parsed.success ? parsed.data.error.message : 'TradeScript license access is unavailable.',
        )
      }
      if (generation !== this.#generation)
        throw new RequestError(409, 'License syncing was cancelled.')
      return response.json()
    }
    let status = LicenseStatusSchema.parse(await request('GET', '/api/v1/terminal/license'))
    if (expectedAccountId && status.account.id !== expectedAccountId) {
      throw new RequestError(
        409,
        `This app is signed in as ${status.account.email}. Log out and sign in to the account used in the console.`,
      )
    }
    if (initialLogin && status.license.status === 'not-provisioned') {
      this.#snapshot = {
        state: 'signed-in',
        ...status,
        message:
          status.license.kind === 'paid' ? 'Preparing your license…' : 'Preparing your free trial…',
      }
      await request('POST', '/api/v1/development-access', { requestId: randomUUID() })
      // The existing provisioner owns issuance and the original trial clock.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (generation !== this.#generation)
          throw new RequestError(409, 'License syncing was cancelled.')
        status = LicenseStatusSchema.parse(await request('GET', '/api/v1/terminal/license'))
        if (
          (status.license.status === 'active' && status.license.credentialsAvailable) ||
          status.license.status === 'expired' ||
          status.license.status === 'inactive'
        )
          break
      }
      if (
        status.license.status === 'not-provisioned' ||
        status.license.status === 'pending' ||
        (status.license.status === 'active' && !status.license.credentialsAvailable)
      ) {
        this.#initialLoginPending = false
        this.#snapshot = {
          state: 'signed-in',
          ...status,
          message:
            'Your license is still being prepared. Press Sync License in a moment to check again.',
        }
        return this.snapshot()
      }
    }
    this.#snapshot = { state: 'signed-in', ...status }
    this.#initialLoginPending = false
    if (status.license.status !== 'active') return this.snapshot()
    const readback = RuntimeReadbackSchema.parse(await request('POST', '/api/v1/terminal/license'))
    if (readback.account.id !== status.account.id)
      throw new RequestError(
        403,
        'The account changed while retrieving the license. Please sign in again.',
      )
    await this.licensing.activate({
      credentialId: readback.authorization.credentialId,
      credentialSecret: readback.authorization.runtimeCredential,
    })
    if (generation !== this.#generation)
      throw new RequestError(409, 'License syncing was cancelled.')
    this.#snapshot = {
      state: 'signed-in',
      account: readback.account,
      license: readback.license,
      message: 'License synced. TradeScript access is active.',
    }
    return this.snapshot()
  }

  logout() {
    if (this.#syncing) throw new RequestError(409, 'License syncing is in progress. Please wait.')
    this.licensing.logout()
    ++this.#generation
    this.cancelLogin()
    this.store.clear()
    this.#session = undefined
    this.#initialLoginPending = false
    this.#snapshot = { state: 'signed-out' }
    return this.snapshot()
  }

  private cancelLogin() {
    if (this.#callbackTimer) clearTimeout(this.#callbackTimer)
    this.#callbackTimer = undefined
    this.#callback?.close()
    this.#callback = undefined
  }

  stop() {
    ++this.#generation
    this.cancelLogin()
  }
}
