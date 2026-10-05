import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const desktop = path.join(root, 'apps/desktop')
const source = path.join(desktop, 'icon.png')
const icons = path.join(desktop, 'src-tauri/icons')
const publicDirectory = path.join(root, 'apps/terminal/public')
const generated = await mkdtemp(path.join(tmpdir(), 'ibkr-terminal-icons-'))
try {
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js')
  const result = spawnSync(process.execPath, [cli, 'icon', source, '--output', generated], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error('Desktop icon generation failed.')
  for (const entry of await readdir(generated, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:png|icns|ico)$/u.test(entry.name))
      await copyFile(path.join(generated, entry.name), path.join(icons, entry.name))
  }
  await copyFile(
    path.join(generated, '128x128@2x.png'),
    path.join(publicDirectory, 'terminal-logo.png'),
  )
  await copyFile(path.join(generated, '64x64.png'), path.join(publicDirectory, 'favicon.png'))
  for (const obsolete of [
    path.join(icons, 'app-icon.svg'),
    path.join(publicDirectory, 'terminal-logo.svg'),
    path.join(publicDirectory, 'favicon.svg'),
    path.join(publicDirectory, 'tradescript-mark.svg'),
  ])
    await rm(obsolete, { force: true })
  console.log('Generated native and web icons from apps/desktop/icon.png')
} finally {
  await rm(generated, { recursive: true, force: true })
}
