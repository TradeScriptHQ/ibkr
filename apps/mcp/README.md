# Local MCP service

The MCP service exposes the mounted terminal SDK to a user's own local AI client.
Start it through the root development launcher or desktop runtime; standalone startup
does not supply the authenticated browser bridge.

| Module under `src/` | Ownership |
| --- | --- |
| `main.ts` | CLI/worker entry point using the shared service lifecycle |
| `service.ts` | Compose listeners, bridge, transports and idempotent shutdown |
| `browser-bridge.ts` | One-time pairing tokens, attached sockets and pending calls |
| `http.ts` | Loopback HTTP request handling and transport routing |
| `transport.ts` | MCP client session/transport lifetime |
| `tools.ts` | Context/discovery/call/batch/subscription/snapshot tools and resources |

Tools delegate to the exact mounted SDK agent authority. They do not create an
independent broker execution path. Only the owning browser socket can settle its
pending calls. Connection permissions and SDK policy apply to agent requests.

Run `npm run test --workspace=@ibkr-terminal/mcp` for the complete integration file,
then the root checks for shared changes. Rendered MCP scenarios are described in
[testing](../../docs/testing.md). Keep pairing capabilities out of URLs and logs.
