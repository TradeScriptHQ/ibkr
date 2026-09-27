import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { prepareNodeRuntime } from './node-runtime.mjs'
import { collectNotices } from './notices.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const desktop = path.join(root, 'apps/desktop/src-tauri')
const { values } = parseArgs({
  options: { 'runtime-only': { type: 'boolean' }, 'output-dir': { type: 'string' } },
})
if (values['output-dir'] && !values['runtime-only'])
  throw new Error('A separate output directory requires --runtime-only')
const output = values['output-dir']
  ? path.resolve(values['output-dir'])
  : path.join(desktop, 'runtime')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
for (const [name, entry] of Object.entries({
  runtime: 'apps/desktop/src/runtime.ts',
  gateway: 'apps/gateway/src/main.ts',
  mcp: 'apps/mcp/src/main.ts',
})) {
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(output, `${name}.mjs`),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    external: ['@tradescript/pro/*'],
  })
}
const sdk = path.join(root, 'node_modules/@tradescript/pro')
const identity = JSON.parse(await readFile(path.join(sdk, 'dist/build-identity/core.json'), 'utf8'))
if (identity.package.version !== '0.1.34') throw new Error('Desktop currently requires SDK 0.1.34')
await writeFile(
  path.join(output, 'sdk.json'),
  JSON.stringify({
    version: identity.package.version,
    fingerprint: identity.buildIdentity.customerBuildFingerprint,
  }),
)
await cp(path.join(root, 'apps/terminal/dist'), path.join(output, 'web'), { recursive: true })
await mkdir(path.join(output, 'web/legal'), { recursive: true })
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
  await cp(path.join(sdk, name), path.join(output, 'web/legal', `SDK-${name}`))
await cp(path.join(root, 'docs/legal'), path.join(output, 'web/legal'), { recursive: true })
await cp(path.join(root, 'LICENSE'), path.join(output, 'web/legal/TERMINAL-LICENSE.txt'))
if (values['runtime-only']) {
  console.log('Prepared isolated desktop runtime')
  process.exit(0)
}
const triple = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout.match(/^host: (.+)$/m)?.[1]
if (!triple) throw new Error('Rust is required for desktop packaging')
const binaryName = `terminal-node-${triple}${process.platform === 'win32' ? '.exe' : ''}`
await mkdir(path.join(desktop, 'binaries'), { recursive: true })
await prepareNodeRuntime(
  root,
  path.join(desktop, 'binaries', binaryName),
  path.join(output, 'web/legal'),
)
await chmod(path.join(desktop, 'binaries', binaryName), 0o755)
await collectNotices(root, path.join(output, 'web/legal'), triple)
console.log(`Prepared desktop runtime for ${triple}`)
