import { afterEach, expect, it, vi } from 'vitest'
import { createMcpAgentConsoleController } from './agent-console.js'

afterEach(() => vi.unstubAllGlobals())

it.each(['ready', 'unavailable'] as const)(
  'publishes checking then %s without stale grants or pairing text',
  async (state) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const controller = createMcpAgentConsoleController('paper', { state: 'checking' })
    controller.publishMcp({ phase: 'connected', endpoint: 'local fixture', controlCount: 3 })
    const listener = vi.fn()
    controller.subscribe(listener)
    expect(controller.getSnapshot().grants?.paperTrading).toMatchObject({
      enabled: false,
      hint: 'Checking agent trading safety. Agent orders are blocked.',
    })
    await controller.commands.copyPairingPrompt?.()
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining('Agent orders are blocked while safety checks complete.'),
    )
    controller.publishAgentRisk(
      state === 'ready' ? { state } : { state, message: 'FX unavailable.' },
    )
    expect(listener).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().grants?.paperTrading?.enabled).toBe(state === 'ready')
    await controller.commands.copyPairingPrompt?.()
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining(
        state === 'ready'
          ? 'Trading is enabled on the selected paper connection.'
          : 'Agent orders are blocked: FX unavailable.',
      ),
    )
    controller.destroy()
  },
)

it('describes unavailable agent risk as paused without granting trading', () => {
  const controller = createMcpAgentConsoleController('paper', {
    state: 'unavailable',
    message: 'A fresh account exchange rate is unavailable.',
  })
  controller.publishMcp({ phase: 'connected', endpoint: 'local fixture', controlCount: 3 })
  const snapshot = controller.getSnapshot()
  expect(snapshot.grants?.paperTrading).toMatchObject({
    enabled: false,
    hint: 'Agent trading paused: A fresh account exchange rate is unavailable.',
  })
  expect(snapshot.capabilities).toMatchObject({
    summaryLabel: expect.stringContaining('agent trading paused'),
  })
  controller.destroy()
})

it.each(['disabled', 'ready'] as const)('reports the actual %s agent authority', (state) => {
  const controller = createMcpAgentConsoleController('paper', { state })
  expect(controller.getSnapshot().grants?.paperTrading?.enabled).toBe(state === 'ready')
  controller.destroy()
})
