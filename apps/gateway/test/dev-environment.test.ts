import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { developmentEnvironment } from '../../../scripts/dev-environment.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function environmentPath(contents?: string, filename = '.env') {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-development-env-'))
  directories.push(directory)
  const path = join(directory, filename)
  if (contents !== undefined) writeFileSync(path, contents, { mode: 0o600 })
  return path
}

it('loads the configured UI origin for every development child and removes registry credentials', () => {
  const base = {
    SENTINEL: 'preserved',
    UI_ORIGIN: 'http://localhost:3000',
    TRADESCRIPT_NPM_TOKEN: 'base-dummy-token',
  }
  const environment = developmentEnvironment(
    base,
    environmentPath(
      'UI_PORT=4567\nTRADESCRIPT_REQUESTED_ORIGIN=http://localhost:4567\nTRADESCRIPT_NPM_TOKEN=file-dummy-token\n',
    ),
  )
  expect(environment.UI_ORIGIN).toBe('http://localhost:4567')
  expect(environment.SENTINEL).toBe('preserved')
  expect(environment.TRADESCRIPT_NPM_TOKEN).toBeUndefined()
  expect(base).toEqual({
    SENTINEL: 'preserved',
    UI_ORIGIN: 'http://localhost:3000',
    TRADESCRIPT_NPM_TOKEN: 'base-dummy-token',
  })
})

it('uses the selected protected environment file by default for the complete workstation', () => {
  const path = environmentPath(
    [
      'UI_PORT=4568',
      'TRADESCRIPT_REQUESTED_ORIGIN=http://localhost:4568',
      'GATEWAY_PORT=4569',
      'TRADESCRIPT_MCP_HTTP_PORT=4570',
      'TRADESCRIPT_MCP_BRIDGE_PORT=4571',
      'TRADESCRIPT_SDK_SOURCE=/tmp/declared-sdk-source',
      'TRADESCRIPT_NPM_TOKEN=file-dummy-token',
      '',
    ].join('\n'),
    'fixture.env',
  )
  const base = {
    TERMINAL_ENV_FILE: path,
    UI_PORT: '3000',
    GATEWAY_PORT: '3001',
    TRADESCRIPT_MCP_HTTP_PORT: '39182',
    TRADESCRIPT_MCP_BRIDGE_PORT: '39181',
    TRADESCRIPT_SDK_SOURCE: '/tmp/inherited-sdk-source',
    TRADESCRIPT_NPM_TOKEN: 'base-dummy-token',
  }
  const environment = developmentEnvironment(base)
  expect(environment.UI_ORIGIN).toBe('http://localhost:4568')
  expect(environment.TERMINAL_ENV_FILE).toBe(path)
  expect(environment.UI_PORT).toBe('4568')
  expect(environment.GATEWAY_PORT).toBe('4569')
  expect(environment.TRADESCRIPT_MCP_HTTP_PORT).toBe('4570')
  expect(environment.TRADESCRIPT_MCP_BRIDGE_PORT).toBe('4571')
  expect(environment.TRADESCRIPT_SDK_SOURCE).toBe('/tmp/declared-sdk-source')
  expect(environment.TRADESCRIPT_NPM_TOKEN).toBeUndefined()
  expect(base.UI_PORT).toBe('3000')
  expect(base.TRADESCRIPT_NPM_TOKEN).toBe('base-dummy-token')
})

it('lets an explicit environment path take precedence over the selected default', () => {
  const selected = environmentPath(
    'UI_PORT=4568\nTRADESCRIPT_REQUESTED_ORIGIN=http://localhost:4568\n',
  )
  const explicit = environmentPath(
    'UI_PORT=4569\nTRADESCRIPT_REQUESTED_ORIGIN=http://localhost:4569\n',
  )
  expect(developmentEnvironment({ TERMINAL_ENV_FILE: selected }, explicit).UI_ORIGIN).toBe(
    'http://localhost:4569',
  )
})

it('passes the default UI origin without a file and never retains an inherited registry token', () => {
  const environment = developmentEnvironment(
    { TRADESCRIPT_NPM_TOKEN: 'dummy-token' },
    environmentPath(),
  )
  expect(environment.UI_ORIGIN).toBe('http://localhost:3000')
  expect(environment.TRADESCRIPT_NPM_TOKEN).toBeUndefined()
})

it('rejects invalid origin configuration before starting child services', () => {
  expect(() => developmentEnvironment({}, environmentPath('UI_PORT=not-a-port\n'))).toThrow()
})
