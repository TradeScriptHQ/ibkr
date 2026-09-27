import { chmod, open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  DESKTOP_DOPPLER_CONFIG,
  DESKTOP_DOPPLER_IDENTITY,
  DESKTOP_DOPPLER_PROJECT,
  DESKTOP_DOPPLER_SELECTIONS,
  selectedSecretNames,
} from './doppler-secret-contract.mjs'

function equalSets(left, right) {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}
export function parseDopplerResponse(source) {
  if (
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    source.success !== true ||
    source.secrets === null ||
    typeof source.secrets !== 'object' ||
    Array.isArray(source.secrets)
  )
    throw new Error('Doppler secret response is invalid')
  const values = {}
  for (const [name, record] of Object.entries(source.secrets)) {
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      typeof record.computed !== 'string' ||
      record.computed.length === 0 ||
      record.computed.includes('\0')
    )
      throw new Error(`Doppler returned an invalid value for ${name}`)
    values[name] = record.computed
  }
  return values
}
export function selectSecrets(values, config = DESKTOP_DOPPLER_CONFIG) {
  const selection = DESKTOP_DOPPLER_SELECTIONS[config]
  if (selection === undefined) throw new Error(`Unsupported Doppler config ${config}`)
  const allowed = new Set(selectedSecretNames(config))
  const unexpected = Object.keys(values).filter(
    (name) => !allowed.has(name) && !(name in DESKTOP_DOPPLER_IDENTITY),
  )
  if (unexpected.length > 0)
    throw new Error(`Doppler returned unexpected secrets: ${unexpected.sort().join(', ')}`)
  for (const [name, expected] of Object.entries(DESKTOP_DOPPLER_IDENTITY)) {
    if (values[name] !== expected)
      throw new Error(`Doppler ${name} does not match the approved ${config} identity`)
  }
  for (const name of allowed) {
    if (values[name] === undefined)
      throw new Error(`Doppler ${config} is missing the required secret ${name}`)
  }
  return Object.fromEntries(
    Object.entries(selection).map(([boundary, names]) => [
      boundary,
      Object.fromEntries(names.map((name) => [name, values[name]])),
    ]),
  )
}
async function requestSecrets(token, config, names) {
  const parameters = new URLSearchParams({
    project: DESKTOP_DOPPLER_PROJECT,
    config,
    secrets: names.join(','),
  })
  const response = await fetch(
    `https://api.doppler.com/v3/configs/config/secrets?${parameters.toString()}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (!response.ok) throw new Error(`Doppler secret download failed with status ${response.status}`)
  return parseDopplerResponse(await response.json())
}
export async function fetchDesktopSecrets({ token, config = DESKTOP_DOPPLER_CONFIG }) {
  if (typeof token !== 'string' || token.length === 0)
    throw new Error('DOPPLER_TOKEN is required to fetch desktop release secrets')
  const names = selectedSecretNames(config)
  const values = await requestSecrets(token, config, names)
  const expected = new Set([...names, ...Object.keys(DESKTOP_DOPPLER_IDENTITY)])
  if (!equalSets(new Set(Object.keys(values)), expected))
    throw new Error(`Doppler ${config} returned an unexpected secret set`)
  return selectSecrets(values, config)
}
export async function writeSecretFile(file, secrets) {
  const handle = await open(file, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(secrets, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(file, 0o600)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.argv[2]
  if (!output) throw new Error('usage: fetch-doppler-secrets.mjs <output-json>')
  const secrets = await fetchDesktopSecrets({ token: process.env.DOPPLER_TOKEN })
  await writeSecretFile(output, secrets)
  process.stdout.write(`Fetched desktop release secrets for ${DESKTOP_DOPPLER_CONFIG}\n`)
}
