import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadRootEnvironment } from '../apps/gateway/src/environment.js'

const rootEnvPath = fileURLToPath(new URL('../.env', import.meta.url))
const environment = loadRootEnvironment({}, rootEnvPath)
const packageName = environment.TRADESCRIPT_PACKAGE_NAME
const sdkVersion = environment.TRADESCRIPT_SDK_VERSION
const npmToken = environment.TRADESCRIPT_NPM_TOKEN
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const developerConsolePackagePattern = /^@tradescript\/pro-[a-z0-9]+(?:-[a-z0-9]+)*$/u

if (packageName === undefined || !developerConsolePackagePattern.test(packageName)) {
  throw new Error('TRADESCRIPT_PACKAGE_NAME must match the exact Developer Console handoff')
}
if (sdkVersion === undefined || !exactVersionPattern.test(sdkVersion)) {
  throw new Error('TRADESCRIPT_SDK_VERSION must be the exact Developer Console version')
}
if (npmToken === undefined || npmToken.length < 16) {
  throw new Error('TRADESCRIPT_NPM_TOKEN is missing from the owner-only .env file')
}

const sdkCoordinate = `@tradescript/pro@npm:${packageName}@${sdkVersion}`
const child = spawn(
  'npm',
  ['install', '--workspace=@ibkr-terminal/terminal', '--save-exact', sdkCoordinate],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, TRADESCRIPT_NPM_TOKEN: npmToken },
    stdio: 'inherit',
  },
)

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (signal !== null) reject(new Error(`TradeScript installation stopped with ${signal}`))
    else resolve(code ?? 1)
  })
})

if (exitCode !== 0) process.exitCode = exitCode
