import { spawn } from 'node:child_process'
import { fetchDesktopSecrets } from './fetch-doppler-secrets.mjs'

// Signing credentials enter only the final packaging process, after installation and checks.
const secrets = await fetchDesktopSecrets({ token: process.env.DOPPLER_TOKEN })
const { DOPPLER_TOKEN: _token, ...environment } = process.env
for (const value of Object.values(secrets.signing)) {
  process.stdout.write(
    `::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`,
  )
}
const child = spawn(
  'npm',
  ['run', 'build', '--workspace=@ibkr-terminal/desktop', '--', ...process.argv.slice(2)],
  {
    env: { ...environment, ...secrets.signing },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
)
child.once('error', () => {
  process.exitCode = 1
})
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
