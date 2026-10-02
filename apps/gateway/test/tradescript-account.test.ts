import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountSessionStore, TradeScriptAccount } from '../src/tradescript/account.js'

const userId = 'b678bd76-05ea-43df-9e2b-141e15f1a5d3'
const accountId = '8dc43b3e-8c46-4c0a-a51e-cfe383a45762'
const account = { id: accountId, email: 'trader@example.test' }
const license = {
  status: 'active',
  kind: 'trial',
  plan: 'free',
  trialDays: 7,
  trialEndsAt: '2026-10-09T00:00:00Z',
  credentialsAvailable: true,
}
const token = {
  access_token: 'fixture-access',
  refresh_token: 'fixture-refresh',
  expires_in: 3600,
  user: { id: userId, email: account.email },
}
const fixtures: Array<{ close: () => void; directory: string }> = []
afterEach(() => {
  for (const item of fixtures.splice(0)) {
    item.close()
    rmSync(item.directory, { recursive: true, force: true })
  }
})

function fixture(saved = false) {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-account-test-'))
  const path = join(directory, 'account.json')
  const store = new AccountSessionStore(path, randomBytes(32))
  if (saved) store.write({ ...token, expires_at: Math.floor(Date.now() / 1000) + 3600 })
  const licensing = {
    activate: vi.fn().mockResolvedValue({ configured: true, ready: true }),
    logout: vi.fn(),
  }
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/v1/auth/configuration')
      return Response.json({
        supabaseURL: 'https://identity.example.test',
        publishableKey: 'public-fixture-key',
      })
    if (url.pathname === '/auth/v1/token') return Response.json(token)
    if (url.pathname === '/api/v1/terminal/license') {
      if (init?.method === 'POST')
        return Response.json({
          account,
          license,
          authorization: { credentialId: 'existing-runtime', runtimeCredential: 'existing-secret' },
        })
      return Response.json({ account, license })
    }
    throw new Error('Unexpected account request')
  })
  const controller = new TradeScriptAccount(store, licensing, { fetch: transport })
  fixtures.push({ close: () => controller.stop(), directory })
  return { controller, store, path, transport, licensing }
}
function callback(login: { url: string }, stateOverride?: string) {
  const url = new URL(login.url)
  const result = new URL(`http://127.0.0.1:${url.searchParams.get('callback_port')}/callback`)
  result.searchParams.set('code', 'one-time-fixture-code')
  result.searchParams.set('state', stateOverride ?? url.searchParams.get('state') ?? '')
  return result
}

it('owns PKCE, rejects a wrong callback state, and retrieves existing credentials after verified sign-in', async () => {
  const item = fixture()
  const login = await item.controller.login()
  const entry = new URL(login.url)
  expect(entry.pathname).toBe('/login')
  expect(entry.searchParams.get('mode')).toBe('trader')
  expect(entry.searchParams.get('native')).toBe('1')
  expect(login.url).not.toMatch(/fixture-access|fixture-refresh|existing-secret/u)
  expect((await fetch(callback(login, 'x'.repeat(43)))).status).toBe(400)
  expect((await fetch(callback(login, 'é'.repeat(43)))).status).toBe(400)
  expect(item.controller.snapshot().state).toBe('authenticating')
  expect((await fetch(callback(login))).status).toBe(200)
  await vi.waitFor(() =>
    expect(item.licensing.activate).toHaveBeenCalledWith({
      credentialId: 'existing-runtime',
      credentialSecret: 'existing-secret',
    }),
  )
  const exchange = item.transport.mock.calls.find(
    ([url]) => new URL(String(url)).pathname === '/auth/v1/token',
  )
  const body = JSON.parse(String(exchange?.[1]?.body))
  expect(body.auth_code).toBe('one-time-fixture-code')
  expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(
    entry.searchParams.get('code_challenge'),
  )
  expect(item.controller.snapshot()).toMatchObject({ state: 'signed-in', account, license })
  expect(JSON.stringify(item.controller.snapshot())).not.toMatch(
    /fixture-access|fixture-refresh|existing-secret/u,
  )
  expect(readFileSync(item.path, 'utf8')).not.toMatch(/fixture-access|fixture-refresh/u)
  expect(item.store.read()?.user.id).toBe(userId)
})

it('syncs the same credentials repeatedly without provisioning, consuming, rotating, or logging out cloud access', async () => {
  const item = fixture(true)
  await item.controller.sync()
  await item.controller.sync(accountId)
  expect(item.licensing.activate).toHaveBeenCalledTimes(2)
  expect(
    item.transport.mock.calls.every(
      ([url]) => new URL(String(url)).pathname === '/api/v1/terminal/license',
    ),
  ).toBe(true)
  item.controller.logout()
  expect(item.licensing.logout).toHaveBeenCalledOnce()
  expect(item.store.read()).toBeUndefined()
  expect(item.controller.snapshot()).toEqual({ state: 'signed-out' })
  await expect(item.controller.sync()).rejects.toThrow('Log in to TradeScript')
  expect(item.transport.mock.calls.every(([url]) => !String(url).includes('logout'))).toBe(true)
})

it('rejects a portal account mismatch before credential readback or local activation', async () => {
  const item = fixture(true)
  await expect(item.controller.sync(userId)).rejects.toThrow('account used in the console')
  expect(item.licensing.activate).not.toHaveBeenCalled()
  expect(item.transport).toHaveBeenCalledOnce()
  expect(item.transport.mock.calls[0]?.[1]?.method).toBe('GET')
  expect(item.store.read()?.user.id).toBe(userId)
})

it('keeps expired trial identity available for buying and never retrieves its credential secret', async () => {
  const item = fixture(true)
  item.transport.mockResolvedValue(
    Response.json({ account, license: { ...license, status: 'expired' } }),
  )
  expect((await item.controller.sync()).license?.status).toBe('expired')
  expect(item.licensing.activate).not.toHaveBeenCalled()
  expect(item.controller.purchaseURL()).toBe(
    'https://console.tradescript.dev/login?mode=trader&plan=individual',
  )
})

it('preserves local credentials when runtime readback fails instead of inventing replacements', async () => {
  const item = fixture(true)
  item.transport.mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? Response.json(
          { error: { message: 'Existing credentials are unavailable. Contact support.' } },
          { status: 409 },
        )
      : Response.json({ account, license }),
  )
  await expect(item.controller.sync()).rejects.toThrow('Existing credentials are unavailable')
  expect(item.licensing.activate).not.toHaveBeenCalled()
  expect(item.licensing.logout).not.toHaveBeenCalled()
  expect(item.controller.snapshot().account).toEqual(account)
})

it('renews its standard Supabase session before reading the authoritative account license', async () => {
  const item = fixture()
  item.store.write({ ...token, expires_at: 1 })
  const restarted = new TradeScriptAccount(item.store, item.licensing, { fetch: item.transport })
  fixtures.push({ close: () => restarted.stop(), directory: join(item.path, '..', 'unused') })
  await restarted.sync()
  const request = item.transport.mock.calls.find(([url]) =>
    String(url).includes('grant_type=refresh_token'),
  )
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ refresh_token: token.refresh_token })
  expect(item.store.read()?.expires_at).toBeGreaterThan(Date.now() / 1000)
  expect(item.licensing.activate).toHaveBeenCalledOnce()
})

it('cancels its callback listener on logout and cannot restore account credentials from a late browser return', async () => {
  const item = fixture()
  const login = await item.controller.login()
  item.controller.logout()
  await expect(fetch(callback(login))).rejects.toThrow()
  expect(item.controller.snapshot()).toEqual({ state: 'signed-out' })
  expect(item.licensing.activate).not.toHaveBeenCalled()
  expect(item.store.read()).toBeUndefined()
})

it('issues initial trial access once only during explicit first login, then passive syncing reads that same license', async () => {
  const item = fixture()
  let provisioned = false
  item.transport.mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/v1/auth/configuration')
      return Response.json({
        supabaseURL: 'https://identity.example.test',
        publishableKey: 'public-fixture-key',
      })
    if (url.pathname === '/auth/v1/token') return Response.json(token)
    if (url.pathname === '/api/v1/development-access') {
      provisioned = true
      return Response.json({ request: { status: 'queued' } })
    }
    if (url.pathname === '/api/v1/terminal/license' && init?.method === 'GET')
      return Response.json({
        account,
        license: provisioned
          ? license
          : { ...license, status: 'not-provisioned', credentialsAvailable: false },
      })
    return Response.json({
      account,
      license,
      authorization: { credentialId: 'existing-runtime', runtimeCredential: 'existing-secret' },
    })
  })
  const login = await item.controller.login()
  await fetch(callback(login))
  await vi.waitFor(() => expect(item.licensing.activate).toHaveBeenCalledOnce(), { timeout: 4000 })
  await item.controller.sync()
  expect(
    item.transport.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === '/api/v1/development-access',
    ),
  ).toHaveLength(1)
  expect(item.licensing.activate).toHaveBeenCalledTimes(2)
})

it('does not issue a trial from passive syncing or discard credentials during an in-flight sync', async () => {
  const item = fixture(true)
  let resolveStatus: ((value: Response) => void) | undefined
  item.transport.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveStatus = resolve
      }),
  )
  const syncing = item.controller.sync()
  await vi.waitFor(() => expect(resolveStatus).toBeTypeOf('function'))
  const wrongAccount = item.controller.sync(userId)
  expect(() => item.controller.logout()).toThrow('syncing is in progress')
  expect(item.licensing.logout).not.toHaveBeenCalled()
  resolveStatus?.(
    Response.json({
      account,
      license: { ...license, status: 'not-provisioned', credentialsAvailable: false },
    }),
  )
  expect((await syncing).license?.status).toBe('not-provisioned')
  await expect(wrongAccount).rejects.toThrow('account used in the console')
  expect(item.transport).toHaveBeenCalledOnce()
  expect(item.licensing.activate).not.toHaveBeenCalled()
})

it('requires normal authenticator verification before license readback and stores only the upgraded same-user session', async () => {
  const item = fixture()
  const factorId = '5f0b6527-a7b3-4e7f-ad2f-458fcb3cd0d8'
  const challengeId = '9b74e63d-9f79-4b59-90ea-f742bb53370c'
  item.store.write({
    ...token,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { ...token.user, factors: [{ id: factorId, factor_type: 'totp', status: 'verified' }] },
  })
  let verified = false
  item.transport.mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/v1/auth/configuration')
      return Response.json({
        supabaseURL: 'https://identity.example.test',
        publishableKey: 'public-fixture-key',
      })
    if (url.pathname.endsWith('/challenge')) return Response.json({ id: challengeId })
    if (url.pathname.endsWith('/verify')) {
      expect(JSON.parse(String(init?.body))).toEqual({ challenge_id: challengeId, code: '123456' })
      verified = true
      return Response.json({ ...token, access_token: 'fixture-aal2-access' })
    }
    if (!verified)
      return Response.json(
        { error: { code: 'mfa_required', message: 'Complete two-step verification to continue.' } },
        { status: 403 },
      )
    return Response.json({
      account,
      license,
      ...(init?.method === 'POST'
        ? {
            authorization: {
              credentialId: 'existing-runtime',
              runtimeCredential: 'existing-secret',
            },
          }
        : {}),
    })
  })
  const restarted = new TradeScriptAccount(item.store, item.licensing, { fetch: item.transport })
  await expect(restarted.sync()).rejects.toThrow('two-step')
  expect(restarted.snapshot().state).toBe('mfa-required')
  expect(item.licensing.activate).not.toHaveBeenCalled()
  await expect(restarted.verifyMfa('bad')).rejects.toThrow('six-digit')
  await restarted.verifyMfa('123456')
  expect(restarted.snapshot().state).toBe('signed-in')
  expect(item.store.read()?.access_token).toBe('fixture-aal2-access')
  expect(item.licensing.activate).toHaveBeenCalledOnce()
  restarted.stop()
})

it.each(['challenge', 'verify'] as const)(
  'keeps logout authoritative while the authenticator %s response body is pending',
  async (phase) => {
    const item = fixture()
    const factorId = '5f0b6527-a7b3-4e7f-ad2f-458fcb3cd0d8'
    const challengeId = '9b74e63d-9f79-4b59-90ea-f742bb53370c'
    item.store.write({
      ...token,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { ...token.user, factors: [{ id: factorId, factor_type: 'totp', status: 'verified' }] },
    })
    let completeBody: (value: unknown) => void = () => undefined
    const body = new Promise<unknown>((resolve) => {
      completeBody = resolve
    })
    const parsing = vi.fn()
    const pendingResponse = Response.json({})
    vi.spyOn(pendingResponse, 'json').mockImplementation(() => {
      parsing()
      return body
    })
    item.transport.mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/auth/configuration')
        return Response.json({
          supabaseURL: 'https://identity.example.test',
          publishableKey: 'public-fixture-key',
        })
      if (url.pathname.endsWith(`/${phase}`)) return pendingResponse
      if (url.pathname.endsWith('/challenge')) return Response.json({ id: challengeId })
      if (url.pathname.endsWith('/verify')) return Response.json(token)
      return Response.json({
        account,
        license,
        authorization: { credentialId: 'existing-runtime', runtimeCredential: 'existing-secret' },
      })
    })
    const restarted = new TradeScriptAccount(item.store, item.licensing, { fetch: item.transport })
    const verifying = restarted.verifyMfa('123456')
    const cancelled = expect(verifying).rejects.toThrow('Sign-in was cancelled')
    await vi.waitFor(() => expect(parsing).toHaveBeenCalledOnce())
    restarted.logout()
    completeBody(
      phase === 'challenge'
        ? { id: challengeId }
        : { ...token, access_token: 'fixture-aal2-access' },
    )
    await cancelled
    expect(restarted.snapshot()).toEqual({ state: 'signed-out' })
    expect(item.store.read()).toBeUndefined()
    expect(item.licensing.logout).toHaveBeenCalledOnce()
    expect(item.licensing.activate).not.toHaveBeenCalled()
    expect(
      item.transport.mock.calls.some(
        ([input]) => new URL(String(input)).pathname === '/api/v1/terminal/license',
      ),
    ).toBe(false)
    restarted.stop()
  },
)

it('gives an explicit Sync License retry after slow initial issuance instead of an indefinite preparation message', async () => {
  const item = fixture(true)
  item.transport.mockImplementation(async (input) =>
    new URL(String(input)).pathname === '/api/v1/development-access'
      ? Response.json({ request: { status: 'queued' } })
      : Response.json({
          account,
          license: { ...license, status: 'not-provisioned', credentialsAvailable: false },
        }),
  )
  vi.useFakeTimers()
  try {
    const pending = item.controller.sync(undefined, true)
    await vi.advanceTimersByTimeAsync(30000)
    const status = await pending
    expect(status.message).toBe(
      'Your license is still being prepared. Press Sync License in a moment to check again.',
    )
    expect(item.licensing.activate).not.toHaveBeenCalled()
    expect(
      item.transport.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === '/api/v1/development-access',
      ),
    ).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
})
