import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const version = process.env.RELEASE_VERSION
if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('Set RELEASE_VERSION to a release version such as 0.1.0')
const repository = process.env.GITHUB_REPOSITORY
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error('Set GITHUB_REPOSITORY to the public OWNER/REPO release repository')
const pubkey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim()
if (!pubkey) throw new Error('Set TAURI_UPDATER_PUBLIC_KEY')
const config = {
  version,
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      pubkey,
      endpoints: [`https://github.com/${repository}/releases/latest/download/latest.json`],
    },
  },
}
await writeFile(
  fileURLToPath(new URL('../../apps/desktop/src-tauri/tauri.release.json', import.meta.url)),
  JSON.stringify(config, null, 2),
)
