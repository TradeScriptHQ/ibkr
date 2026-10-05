#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const desktop = path.join(root, 'apps/desktop/src-tauri')

function xml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character],
  )
}

export async function prepareDevelopmentBundle(
  binary,
  { outputDirectory = path.join(root, '.local/desktop-dev') } = {},
) {
  if (process.platform !== 'darwin') throw new Error('The desktop app runner is macOS only')
  const source = await realpath(binary)
  if (path.basename(source) !== 'tradescript-terminal') {
    throw new Error('The desktop runner requires the tradescript-terminal native executable')
  }
  const config = JSON.parse(await readFile(path.join(desktop, 'tauri.conf.json'), 'utf8'))
  const name = `${config.productName} Dev`
  const bundle = path.join(outputDirectory, `${name}.app`)
  const contents = path.join(bundle, 'Contents')
  const executable = path.join(contents, 'MacOS/tradescript-terminal')
  const staged = `${executable}.${process.pid}.tmp`
  await mkdir(path.dirname(executable), { recursive: true })
  await mkdir(path.join(contents, 'Resources'), { recursive: true })
  try {
    await copyFile(source, staged)
    await chmod(staged, 0o755)
    await rename(staged, executable)
  } finally {
    await rm(staged, { force: true })
  }
  await copyFile(path.join(desktop, 'icons/icon.icns'), path.join(contents, 'Resources/icon.icns'))
  const values = {
    CFBundleIdentifier: `${config.identifier}.development`,
    CFBundleExecutable: 'tradescript-terminal',
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: config.version,
    CFBundleVersion: config.version,
    CFBundleIconFile: 'icon.icns',
    LSMinimumSystemVersion: config.bundle.macOS.minimumSystemVersion,
  }
  await writeFile(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${Object.entries(values)
  .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
  .join('\n')}
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
  )
  return { bundle, executable }
}

export async function runDevelopmentExecutable(executable, args, parent = process.ppid) {
  // Only the native executable and app identity are wrapped. Vite and all local
  // workstation services remain owned by the root development launcher.
  const child = spawn(executable, args, { stdio: 'inherit' })
  let stopping = false
  let forceTimer
  const stop = (signal) => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return
    stopping = true
    child.kill(signal)
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 8_000)
    forceTimer.unref()
  }
  const signals = new Map(
    ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
      const handler = () => stop(signal)
      process.on(signal, handler)
      return [signal, handler]
    }),
  )
  // Tauri stops Cargo when rebuilding Rust. If Cargo is killed before it can
  // signal its runner, terminate this runner's own native child as well.
  const parentWatcher = setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch (error) {
      if (error.code === 'ESRCH') stop('SIGTERM')
    }
  }, 200)
  parentWatcher.unref()
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    return result.code ?? 128 + (constants.signals[result.signal] ?? 1)
  } finally {
    clearInterval(parentWatcher)
    clearTimeout(forceTimer)
    for (const [signal, handler] of signals) process.off(signal, handler)
  }
}

async function run() {
  const [binary, ...args] = process.argv.slice(2)
  if (!binary) throw new Error('Cargo must supply the desktop native executable to the runner')
  const parent = process.ppid
  const { executable } = await prepareDevelopmentBundle(binary)
  process.exitCode = await runDevelopmentExecutable(executable, args, parent)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await run()
}
