import { afterEach, expect, it, vi } from 'vitest'
import { initializeWorkstationAgentRisk } from './workstation-agent-risk.js'

const createRisk = vi.hoisted(() => vi.fn())
vi.mock('./risk.js', () => ({ createConnectionRiskAuthority: createRisk }))
afterEach(() => vi.resetAllMocks())

function inputs(enabled = true) {
  return [
    {},
    {},
    {},
    { enabled, autonomyMode: 'paper-auto', allowedAccountIds: ['paper-fixture'], limits: {} },
    'paper',
  ] as unknown as Parameters<typeof initializeWorkstationAgentRisk>
}

it('does not allocate an agent risk authority when agent trading is disabled', async () => {
  expect(await initializeWorkstationAgentRisk(...inputs(false))).toEqual({ state: 'disabled' })
  expect(createRisk).not.toHaveBeenCalled()
})

it('reports missing currency conversion as agent unavailability rather than startup failure', async () => {
  createRisk.mockRejectedValue(new Error('A fresh account currency conversion is unavailable.'))
  expect(await initializeWorkstationAgentRisk(...inputs())).toEqual({
    state: 'unavailable',
    message: 'A fresh account currency conversion is unavailable.',
  })
})

it('provides trade authority only after complete risk initialization succeeds', async () => {
  const authority = { controller: {}, requests: {}, destroy: vi.fn() }
  createRisk.mockResolvedValue(authority)
  expect(await initializeWorkstationAgentRisk(...inputs())).toEqual({ state: 'ready', authority })
  expect(createRisk).toHaveBeenCalledWith(...inputs())
})

it('retries the real initialization and never promotes a previous failure into authority', async () => {
  const authority = { controller: {}, requests: {}, destroy: vi.fn() }
  createRisk.mockRejectedValueOnce(new Error('Currency conversion unavailable.'))
  createRisk.mockResolvedValueOnce(authority)
  expect(await initializeWorkstationAgentRisk(...inputs())).toMatchObject({ state: 'unavailable' })
  expect(await initializeWorkstationAgentRisk(...inputs())).toEqual({ state: 'ready', authority })
  expect(createRisk).toHaveBeenCalledTimes(2)
})

it('keeps non-Error initialization failures unavailable without supplying risk facts', async () => {
  createRisk.mockRejectedValue(undefined)
  expect(await initializeWorkstationAgentRisk(...inputs())).toEqual({
    state: 'unavailable',
    message: 'The broker risk checks could not be completed.',
  })
})
