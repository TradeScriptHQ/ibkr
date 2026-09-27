import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { BrowserBridge } from './browser-bridge.js'
import { readJson, sendJson } from './http.js'
import { createTradeScriptMcpServer } from './tools.js'

interface McpTransportRecord {
  readonly server: McpServer
  readonly transport: StreamableHTTPServerTransport
}

export function createMcpTransport(bridge: BrowserBridge) {
  const transports = new Map<string, McpTransportRecord>()
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = request.method === 'POST' ? await readJson(request) : undefined
    const header = request.headers['mcp-session-id']
    const transportSessionId = Array.isArray(header) ? header[0] : header
    let record = transportSessionId === undefined ? undefined : transports.get(transportSessionId)

    if (record === undefined && transportSessionId === undefined && isInitializeRequest(body)) {
      let created: McpTransportRecord
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized(id) {
          transports.set(id, created)
        },
        onsessionclosed(id) {
          if (transports.get(id) === created) transports.delete(id)
        },
      })
      const server = createTradeScriptMcpServer(randomUUID(), bridge)
      created = { server, transport }
      transport.onclose = () => {
        const id = transport.sessionId
        if (id !== undefined && transports.get(id) === created) transports.delete(id)
      }
      await server.connect(transport as Parameters<typeof server.connect>[0])
      record = created
    }

    if (record === undefined) {
      sendJson(response, transportSessionId === undefined ? 400 : 404, {
        jsonrpc: '2.0',
        error: {
          code: -32_000,
          message: transportSessionId === undefined ? 'Missing MCP session' : 'Unknown MCP session',
        },
        id: null,
      })
      return
    }
    await record.transport.handleRequest(request, response, body)
  }

  return {
    handle,
    async close() {
      await Promise.all([...transports.values()].map(({ server }) => server.close()))
      transports.clear()
    },
  }
}
