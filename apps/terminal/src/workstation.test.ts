import { afterEach, expect, it, vi } from 'vitest'
import type { createTerminalTradeScriptSdk } from './terminal-session.js'
import { createWorkstation } from './workstation.js'

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), sdk: vi.fn(), remove: vi.fn() }))
vi.mock('./workstation-authorization.js', () => ({ authorizeWorkstation: mocks.authorize }))
vi.mock('./terminal-session.js', () => ({ createTerminalTradeScriptSdk: mocks.sdk }))
vi.mock('./workstation-e2e.js', () => ({
  removeWorkstationE2e: mocks.remove,
  installWorkstationE2e: vi.fn(),
}))

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function options() {
  return {
    host: {} as HTMLDivElement,
    setChartBarsReader: vi.fn(),
    setActiveInstrument: vi.fn(),
    setLoadState: vi.fn(),
    mockMode: false,
  }
}

it('releases an SDK that finishes loading after the workstation is disposed', async () => {
  mocks.authorize.mockResolvedValue({
    session: {},
    status: { environment: 'paper' },
    bootstrap: { lease: 'test' },
  })
  vi.stubGlobal('document', { title: '' })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof createTerminalTradeScriptSdk>>>()
  mocks.sdk.mockReturnValue(pending.promise)
  const props = options()
  const workstation = createWorkstation(props)
  await vi.waitFor(() => expect(mocks.sdk).toHaveBeenCalledOnce())
  await workstation.dispose()
  const close = vi.fn()
  const mount = vi.fn()
  // Only teardown may touch this late SDK; mounting it would be a lifecycle regression.
  pending.resolve({ close, tradingTerminal: { mount } } as unknown as Awaited<
    ReturnType<typeof createTerminalTradeScriptSdk>
  >)
  await workstation.started
  await workstation.dispose()
  expect(close).toHaveBeenCalledOnce()
  expect(mount).not.toHaveBeenCalled()
  expect(mocks.remove).toHaveBeenCalledOnce()
  expect(props.setLoadState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'ready' }))
})

it('aborts authorization and prevents startup from publishing errors after disposal', async () => {
  const pending = Promise.withResolvers<never>()
  mocks.authorize.mockReturnValue(pending.promise)
  const props = options()
  const workstation = createWorkstation(props)
  const signal = mocks.authorize.mock.calls[0]?.[0] as AbortSignal
  await workstation.dispose()
  expect(signal.aborted).toBe(true)
  pending.reject(new Error('late authorization failure'))
  await workstation.started
  expect(props.setLoadState).not.toHaveBeenCalled()
  expect(mocks.sdk).not.toHaveBeenCalled()
})

it('reports startup failures and releases the attempt without waiting for React to unmount', async () => {
  mocks.authorize.mockRejectedValue(new Error('Gateway unavailable'))
  const props = options()
  const workstation = createWorkstation(props)
  await workstation.started
  expect(props.setLoadState).toHaveBeenCalledWith({
    state: 'error',
    message: 'Gateway unavailable',
  })
  expect(mocks.remove).toHaveBeenCalledOnce()
  await workstation.dispose()
  expect(mocks.remove).toHaveBeenCalledOnce()
})
