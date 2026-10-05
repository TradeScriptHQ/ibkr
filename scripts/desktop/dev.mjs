import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const environment = { ...process.env }
const localEnvironment = path.join(root, '.local/desktop-dev/dev.env')
if (!environment.TERMINAL_ENV_FILE && existsSync(localEnvironment))
  environment.TERMINAL_ENV_FILE = localEnvironment

if (process.platform === 'darwin') {
  const target = process.arch === 'arm64' ? 'AARCH64_APPLE_DARWIN' : 'X86_64_APPLE_DARWIN'
  environment[`CARGO_TARGET_${target}_RUNNER`] = fileURLToPath(
    new URL('./dev-runner.mjs', import.meta.url),
  )
}

const child = spawn('npm', ['run', 'dev', '--workspace=@ibkr-terminal/desktop'], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  // Keep every Unix development descendant in a group owned by this launcher.
  // Stopping only npm or Tauri can leave the frontend services or native app running.
  detached: process.platform !== 'win32',
})
let stopping = false
let forceTimer
let cleanupPoll
function signalOwnedProcesses(signal) {
  if (!child.pid) return false
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
    return true
  } catch (error) {
    if (error.code !== 'ESRCH') {
      console.error('The desktop development launcher could not stop its owned processes.')
      process.exitCode = 1
    }
    return false
  }
}
function ownedProcessesRemain() {
  if (!child.pid) return false
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}
function finishCleanup() {
  clearInterval(cleanupPoll)
  clearTimeout(forceTimer)
}
function stop(signal) {
  if (stopping) return
  stopping = true
  signalOwnedProcesses(signal)
  if (!ownedProcessesRemain()) return
  cleanupPoll = setInterval(() => {
    if (!ownedProcessesRemain()) finishCleanup()
  }, 200)
  forceTimer = setTimeout(() => {
    signalOwnedProcesses('SIGKILL')
    finishCleanup()
  }, 8_000)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stop(signal)
  })
}
child.once('error', () => {
  console.error('The desktop development launcher could not start.')
  process.exitCode = 1
  stop('SIGTERM')
})
child.once('exit', (code) => {
  process.exitCode = code ?? (stopping ? 0 : 1)
  // A failed CLI can also leave children behind after its own npm process exits.
  stop('SIGTERM')
})
