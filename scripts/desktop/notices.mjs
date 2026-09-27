import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function collectNotices(root, output, triple) {
  const sections = [
    '# Bundled third-party software\n\nThe TradeScript SDK and Node runtime have separate licence files in this directory.\n',
  ]
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  for (const [location, metadata] of Object.entries(lock.packages)) {
    if (
      !location.includes('node_modules/') ||
      metadata.dev ||
      location === 'node_modules/@tradescript/pro'
    )
      continue
    const folder = path.join(root, location)
    let names
    try {
      names = await readdir(folder)
    } catch {
      continue
    }
    const name = location.split('node_modules/').at(-1)
    sections.push(
      `\n## ${name} ${metadata.version ?? ''}\nLicence: ${metadata.license ?? 'See package notices'}\n`,
    )
    for (const file of names.filter((name) =>
      /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name),
    )) {
      try {
        sections.push(`\n### ${file}\n\n${await readFile(path.join(folder, file), 'utf8')}\n`)
      } catch {
        /* Some packages use a directory. */
      }
    }
  }
  const cargo = spawnSync(
    'cargo',
    [
      'metadata',
      '--locked',
      '--format-version',
      '1',
      '--filter-platform',
      triple,
      '--manifest-path',
      path.join(root, 'apps/desktop/src-tauri/Cargo.toml'),
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  if (cargo.status !== 0)
    throw new Error('Could not collect Rust dependency notices; run cargo fetch first')
  for (const pkg of JSON.parse(cargo.stdout).packages) {
    if (!pkg.source) continue
    const folder = path.dirname(pkg.manifest_path)
    sections.push(
      `\n## ${pkg.name} ${pkg.version}\nLicence: ${pkg.license ?? 'See package notices'}\n`,
    )
    const files = await readdir(folder)
    for (const file of files.filter((name) =>
      /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name),
    )) {
      try {
        sections.push(`\n### ${file}\n\n${await readFile(path.join(folder, file), 'utf8')}\n`)
      } catch {
        /* Directory-based notices are listed separately by the package. */
      }
    }
  }
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'THIRD-PARTY-NOTICES.txt'), sections.join('\n'))
}
