import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createManifest, releaseAssetName } from './update-manifest.mjs'

export async function stageRelease(directory, destination, options) {
  const manifest = await createManifest(directory, options)
  const assets = new Map()
  for (const target of Object.keys(manifest.platforms)) {
    const folder = path.join(directory, target)
    for (const file of await readdir(folder, { recursive: true })) {
      if (!/\.(dmg|exe|tar\.gz|sig)$/.test(file)) continue
      const name = releaseAssetName(target, file)
      if (assets.has(name)) throw new Error(`Duplicate release asset name: ${name}`)
      assets.set(name, path.join(folder, file))
    }
  }
  // Refuse to mix this release with stale files from another staging run.
  await mkdir(destination)
  for (const [name, source] of assets) await copyFile(source, path.join(destination, name))
  await writeFile(path.join(destination, 'latest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , directory, destination] = process.argv
  if (!directory || !destination) throw new Error('Pass artifact and destination directories')
  await stageRelease(directory, destination, {
    version: process.env.RELEASE_VERSION,
    baseUrl: process.env.RELEASE_BASE_URL,
    notes: process.env.RELEASE_NOTES,
  })
}
