import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { stageRelease } from './stage-release.mjs'
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
          ? 'TradeScript Terminal.app.tar.gz'
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
    assert.equal(
      manifest.platforms['darwin-aarch64'].url,
      `${options.baseUrl}/darwin-aarch64-TradeScript.Terminal.app.tar.gz`,
    )
    assert.equal(
      manifest.platforms['windows-x86_64'].url,
      `${options.baseUrl}/windows-x86_64-TradeScript.Terminal_0.1.0_x64-setup.exe`,
    )
    const staged = path.join(dir, 'downloads')
    await stageRelease(dir, staged, options)
    const published = JSON.parse(await readFile(path.join(staged, 'latest.json'), 'utf8'))
    for (const entry of Object.values(published.platforms)) {
      const name = decodeURIComponent(new URL(entry.url).pathname.split('/').at(-1))
      assert.match(name, /^[A-Za-z0-9._-]+$/)
      assert.equal(await readFile(path.join(staged, name), 'utf8'), 'fixture')
      assert.equal(await readFile(path.join(staged, `${name}.sig`), 'utf8'), entry.signature)
    }
    await assert.rejects(stageRelease(dir, staged, options), { code: 'EEXIST' })
    await assert.rejects(createManifest(dir, { ...options, baseUrl: 'http://example.test' }))
    await rm(path.join(dir, 'windows-x86_64', 'TradeScript Terminal_0.1.0_x64-setup.exe'))
    await assert.rejects(createManifest(dir, options))
    await writeFile(
      path.join(dir, 'windows-x86_64', 'TradeScript Terminal_0.1.0_x64-setup.exe'),
      'fixture',
    )
    for (const name of ['TradeScript Terminal.dmg', 'TradeScript.Terminal.dmg'])
      await writeFile(path.join(dir, 'darwin-aarch64', name), 'fixture')
    await assert.rejects(
      stageRelease(dir, path.join(dir, 'collision'), options),
      /Duplicate release asset name/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
