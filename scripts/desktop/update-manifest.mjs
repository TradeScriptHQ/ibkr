import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Choose the upload name ourselves: GitHub replaces spaces in asset filenames.
// Both staging and manifest generation must use the same stable name.
export function releaseAssetName(target, file) {
  return `${target}-${path.basename(file).replace(/[^A-Za-z0-9._-]+/g, '.')}`
}

export async function createManifest(directory, { version, baseUrl, notes = '' }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version')
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('Update downloads require HTTPS')
  const platforms = {}
  for (const target of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']) {
    const folder = path.join(directory, target)
    const files = await readdir(folder, { recursive: true })
    const suffix = target.startsWith('darwin') ? '.app.tar.gz.sig' : '.exe.sig'
    const matches = files.filter((file) => file.endsWith(suffix))
    if (matches.length !== 1) throw new Error(`Expected one signed update artifact for ${target}`)
    const signatureFile = matches[0]
    const artifact = signatureFile.slice(0, -4)
    await readFile(path.join(folder, artifact))
    const signature = (await readFile(path.join(folder, signatureFile), 'utf8')).trim()
    if (!signature) throw new Error(`Missing update signature for ${target}`)
    platforms[target] = {
      signature,
      url: `${baseUrl.replace(/\/$/, '')}/${releaseAssetName(target, artifact)}`,
    }
  }
  return { version, notes, pub_date: new Date().toISOString(), platforms }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv[2]
  const manifest = await createManifest(directory, {
    version: process.env.RELEASE_VERSION,
    baseUrl: process.env.RELEASE_BASE_URL,
    notes: process.env.RELEASE_NOTES,
  })
  await writeFile(path.join(directory, 'latest.json'), JSON.stringify(manifest, null, 2))
}
