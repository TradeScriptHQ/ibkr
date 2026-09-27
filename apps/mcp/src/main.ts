import { runService } from '@ibkr-terminal/service-runtime'
import { startMcpService } from './service.js'

await runService(async () => {
  const httpPort = Number(process.env.TRADESCRIPT_MCP_HTTP_PORT ?? 39182)
  const bridgePort = Number(process.env.TRADESCRIPT_MCP_BRIDGE_PORT ?? 39181)
  for (const port of [httpPort, bridgePort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid MCP port')
  }
  const capability = process.env.INTERNAL_PROXY_CAPABILITY
  if (capability === undefined || capability.length < 32) {
    throw new Error('Start the workstation with the root npm run dev command')
  }
  const service = await startMcpService({
    httpPort,
    bridgePort,
    capability,
    uiOrigin: process.env.UI_ORIGIN ?? 'http://localhost:3000',
  })
  console.log(`TradeScript MCP endpoint: http://127.0.0.1:${httpPort}/mcp`)
  return service
})
