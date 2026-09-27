export const DESKTOP_DOPPLER_PROJECT = 'ibkr'
export const DESKTOP_DOPPLER_CONFIG = 'prd'
export const DESKTOP_DOPPLER_IDENTITY = {
  DOPPLER_PROJECT: DESKTOP_DOPPLER_PROJECT,
  DOPPLER_CONFIG: DESKTOP_DOPPLER_CONFIG,
  DOPPLER_ENVIRONMENT: 'prd',
}
export const DESKTOP_DOPPLER_SELECTIONS = {
  [DESKTOP_DOPPLER_CONFIG]: {
    npm: ['TRADESCRIPT_NPM_TOKEN'],
    signing: ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'],
  },
}
export function selectedSecretNames(config = DESKTOP_DOPPLER_CONFIG) {
  const selection = DESKTOP_DOPPLER_SELECTIONS[config]
  if (selection === undefined) throw new Error(`Unsupported Doppler config ${config}`)
  return [...new Set(Object.values(selection).flat())].sort()
}
export function expectedResponseNames(config = DESKTOP_DOPPLER_CONFIG) {
  return [...selectedSecretNames(config), ...Object.keys(DESKTOP_DOPPLER_IDENTITY)].sort()
}
