import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Builds the macOS app signed with a Developer ID Application identity from the local
// keychain. Notarizes and staples the DMG when APPLE_NOTARY_PROFILE names a
// `xcrun notarytool store-credentials` keychain profile. Extra arguments go to `tauri build`.
if (process.platform !== 'darwin') throw new Error('Signed macOS builds must run on macOS')

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundleRoot = path.join(root, 'apps/desktop/src-tauri/target/release/bundle')

function developerIdentity() {
  if (process.env.APPLE_SIGNING_IDENTITY) return process.env.APPLE_SIGNING_IDENTITY
  const listing = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  const identities = [
    ...new Set(
      [...listing.matchAll(/"(Developer ID Application: [^"]+)"/gu)].map((match) => match[1]),
    ),
  ]
  if (identities.length !== 1)
    throw new Error(
      identities.length === 0
        ? 'No Developer ID Application identity is in the keychain'
        : `Several Developer ID Application identities found; set APPLE_SIGNING_IDENTITY to one of: ${identities.join(', ')}`,
    )
  return identities[0]
}

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

const identity = developerIdentity()
console.log(`Signing with ${identity}`)
// Notarization runs below through a keychain profile, never Tauri's Apple ID variables.
const {
  APPLE_ID: _appleId,
  APPLE_PASSWORD: _applePassword,
  APPLE_API_KEY: _appleApiKey,
  ...environment
} = process.env
run('npm', ['run', 'desktop:prepare'])
// Only notarize DMGs from this build.
rmSync(path.join(bundleRoot, 'dmg'), { recursive: true, force: true })
run('npm', ['run', 'build', '--workspace=@ibkr-terminal/desktop', '--', ...process.argv.slice(2)], {
  ...environment,
  APPLE_SIGNING_IDENTITY: identity,
})

const appPath = path.join(bundleRoot, 'macos', 'IBKR Tradescript Terminal.app')
const dmgDirectory = path.join(bundleRoot, 'dmg')
const dmgs = readdirSync(dmgDirectory)
  .filter((name) => name.endsWith('.dmg'))
  .map((name) => path.join(dmgDirectory, name))
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])

const profile = process.env.APPLE_NOTARY_PROFILE
if (!profile) {
  console.warn(
    'APPLE_NOTARY_PROFILE is not set: the app is signed but not notarized, so Gatekeeper will still block downloaded copies.',
  )
} else {
  for (const dmg of dmgs) {
    run('codesign', ['--force', '--timestamp', '--sign', identity, dmg])
    run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait'])
    run('xcrun', ['stapler', 'staple', dmg])
  }
  run('xcrun', ['stapler', 'staple', appPath])
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
}
