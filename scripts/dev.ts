import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { isolatedMockEnvironment } from './isolated-mock.js'

const capability = randomBytes(32).toString('base64url')
const isolated = process.argv.includes('--isolated-mock')
  ? await isolatedMockEnvironment(Number(process.env.MOCK_E2E_PORT))
  : undefined
const childEnvironment = {
  ...process.env,
  ...isolated?.environment,
  INTERNAL_PROXY_CAPABILITY: capability,
}
if (isolated) {
  delete childEnvironment.WIDGET_IBKR_ENABLE_LIVE_ORDERS
  delete childEnvironment.TERMINAL_DESKTOP
  delete childEnvironment.TRADESCRIPT_NPM_TOKEN
}
process.once('exit', () => {
  void isolated?.cleanup()
})
const children: ChildProcess[] = []
let stopping = false

function start(args: readonly string[]): ChildProcess {
  const child = spawn('npm', [...args], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: 'inherit',
  })
  children.push(child)
  child.once('exit', () => {
    if (children.every((process) => process.exitCode !== null || process.signalCode !== null))
      void isolated?.cleanup()
  })
  child.once('exit', (code, signal) => {
    if (stopping) return
    stopping = true
    for (const sibling of children) {
      if (sibling !== child && sibling.exitCode === null) sibling.kill('SIGTERM')
    }
    if (signal !== null) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
  return child
}

start(['run', 'dev', '--workspace=@ibkr-terminal/gateway'])
start(['run', 'dev', '--workspace=@ibkr-terminal/mcp'])
start(['run', 'dev', '--workspace=@ibkr-terminal/terminal'])

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true
    for (const child of children) {
      if (child.exitCode === null) child.kill(signal)
    }
  })
}
