import { lstatSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const ROOT_ENV_PATH = fileURLToPath(new URL('../../../.env', import.meta.url))

function assertNoDuplicateKeys(contents: string): void {
  const seen = new Set<string>()
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    const key = match?.[1]
    if (key === undefined) continue
    if (seen.has(key)) throw new Error(`Duplicate key ${key} in .env`)
    seen.add(key)
  }
}

export function loadRootEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  environmentPath = ROOT_ENV_PATH,
): NodeJS.ProcessEnv {
  let metadata: ReturnType<typeof lstatSync>
  try {
    metadata = lstatSync(environmentPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...base }
    throw error
  }

  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('.env must be a regular file and cannot be a symbolic link')
  }
  // Windows does not implement POSIX ownership or mode bits, so these guarantees apply on macOS
  // and Linux only. Desktop builds never read a .env; they receive configuration through the
  // credential store and the packaged runtime environment.
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error('.env must be owned by the current user')
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('.env must have mode 0600')
    }
  }

  const contents = readFileSync(environmentPath, 'utf8')
  assertNoDuplicateKeys(contents)
  return { ...base, ...parse(contents) }
}
