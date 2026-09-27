import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadRootEnvironment } from '../apps/gateway/src/environment.js'

const root = path.resolve(import.meta.dirname, '..')
const environment = loadRootEnvironment(process.env, path.join(root, '.env'))
const configuredSource = environment.TRADESCRIPT_SDK_SOURCE?.trim()
if (!configuredSource)
  throw new Error('TRADESCRIPT_SDK_SOURCE is required for source type checking')
const sdkRoot = path.resolve(root, configuredSource)
const sdk = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, { types?: string } | string>
}
if (sdk.name !== '@tradescript/pro') throw new Error('Configured source is not the TradeScript SDK')

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`)
}

// Generate the SDK's own public declarations; never amend the installed package's types.
run('npm', ['run', 'build-dts'], sdkRoot)
const paths: Record<string, string[]> = {}
for (const [entry, definition] of Object.entries(sdk.exports)) {
  if (typeof definition === 'string' || !definition.types) continue
  paths[`@tradescript/pro${entry === '.' ? '' : entry.slice(1)}`] = [
    path.resolve(sdkRoot, definition.types),
  ]
}
const temporary = await mkdtemp(path.join(root, '.source-typecheck-'))
try {
  for (const project of ['apps/terminal/tsconfig.json', 'tsconfig.e2e.json']) {
    const config = path.join(temporary, 'tsconfig.json')
    await writeFile(
      config,
      JSON.stringify({
        extends: path.join(root, project),
        compilerOptions: { paths },
      }),
    )
    run(path.join(root, 'node_modules/.bin/tsc'), ['-p', config, '--noEmit'], root)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
