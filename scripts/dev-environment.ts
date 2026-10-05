import { loadGatewayConfig } from '../apps/gateway/src/config.js'
import { loadRootEnvironment } from '../apps/gateway/src/environment.js'

export function developmentEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  environmentPath = base.TERMINAL_ENV_FILE,
): NodeJS.ProcessEnv {
  const environment = loadRootEnvironment(base, environmentPath)
  const config = loadGatewayConfig(environment)
  delete environment.TRADESCRIPT_NPM_TOKEN
  return { ...environment, UI_ORIGIN: config.ui.origin }
}
