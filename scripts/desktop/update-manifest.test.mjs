import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createManifest } from './update-manifest.mjs'

test('release manifest requires complete signed artifacts with unique GitHub download names', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desktop-release-'))
  try {
    for (const target of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']) {
      const folder = path.join(dir, target)
      await mkdir(folder)
      const file = path.join(
        folder,
        target.startsWith('darwin')
          ? 'Terminal.app.tar.gz'
          : 'TradeScript Terminal_0.1.0_x64-setup.exe',
      )
      await writeFile(file, 'fixture')
      await writeFile(`${file}.sig`, 'fixture-signature')
    }
    const options = {
      version: '0.1.1',
      baseUrl: 'https://github.com/example/terminal/releases/download/v0.1.1',
    }
    const manifest = await createManifest(dir, options)
    assert.equal(Object.keys(manifest.platforms).length, 3)
    assert.notEqual(
      manifest.platforms['darwin-aarch64'].url,
      manifest.platforms['darwin-x86_64'].url,
    )
    assert.equal(manifest.platforms['windows-x86_64'].signature, 'fixture-signature')
    await assert.rejects(createManifest(dir, { ...options, baseUrl: 'http://example.test' }))
    await rm(path.join(dir, 'windows-x86_64', 'TradeScript Terminal_0.1.0_x64-setup.exe'))
    await assert.rejects(createManifest(dir, options))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
