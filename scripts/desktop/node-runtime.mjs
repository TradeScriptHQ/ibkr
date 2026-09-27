import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const VERSION = '24.21.0'
/** Official Node distributions are self-contained; Homebrew's executable is not. */
export async function prepareNodeRuntime(root, destination, notices) {
  if (!['darwin', 'win32'].includes(process.platform))
    throw new Error('Build desktop installers on Mac or Windows')
  const platform = process.platform === 'win32' ? 'win' : 'darwin'
  const basename = `node-v${VERSION}-${platform}-${process.arch}`
  const filename = `${basename}.${platform === 'win' ? 'zip' : 'tar.gz'}`
  const cache = path.join(root, '.local', 'node-runtime')
  await mkdir(cache, { recursive: true })
  const baseUrl = `https://nodejs.org/dist/v${VERSION}`
  const manifest = await fetch(`${baseUrl}/SHASUMS256.txt`)
  if (!manifest.ok) throw new Error('Could not fetch official Node checksums')
  const line = (await manifest.text())
    .split('\n')
    .find((line) => line.trim().endsWith(` ${filename}`))
  if (!line) throw new Error(`No checksum for ${filename}`)
  const expected = line.trim().split(/\s+/)[0]
  const archive = path.join(cache, filename)
  let bytes
  try {
    bytes = await readFile(archive)
  } catch {
    /* Download on first build. */
  }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    const response = await fetch(`${baseUrl}/${filename}`)
    if (!response.ok) throw new Error('Could not download official Node runtime')
    bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new Error('Node runtime checksum mismatch')
    await writeFile(archive, bytes)
  }
  const result =
    platform === 'win'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Expand-Archive -LiteralPath $env:TERMINAL_NODE_ARCHIVE -DestinationPath $env:TERMINAL_NODE_CACHE -Force',
          ],
          {
            env: { ...process.env, TERMINAL_NODE_ARCHIVE: archive, TERMINAL_NODE_CACHE: cache },
            stdio: 'inherit',
          },
        )
      : spawnSync('tar', ['-xzf', archive, '-C', cache], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Could not unpack official Node runtime')
  await cp(path.join(cache, basename, platform === 'win' ? 'node.exe' : 'bin/node'), destination)
  await cp(path.join(cache, basename, 'LICENSE'), path.join(notices, 'NODE-LICENSE.txt'))
}
