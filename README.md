# TradeScript IBKR Terminal

A local trading workstation for Interactive Brokers TWS, with a browser interface,
a macOS/Windows desktop app, and optional access from your own AI client.

Paper and live TWS connections are supported. Each connection has its own account
allowlist and read-only, manual, or manual-and-agent permission. Automated broker
tests are paper-only; compatibility is not a claim of production qualification.
See [current limitations](docs/limitations.md) and the [release checklist](docs/releases.md).

## Run from source

You need Node.js 24+, npm, TWS with API access enabled, and a TradeScript package
download token. Set `TRADESCRIPT_NPM_TOKEN` in your shell without saving it in
source, then run:

```sh
npm ci
npm run dev
```

Open **http://localhost:3000**. Enter your Client key and Secret in first-run
setup, then test and apply a TWS connection. Runtime credentials are separate from
the package download token. TWS normally uses port `7497` for paper and `7496` for
live; the connection must also match the selected account environment.

Optional development overrides are documented in [.env.example](.env.example).
If you create `.env`, set its permissions to `0600` on macOS/Linux before starting.
Always use the root launcher; it owns the local services and authenticated proxy.

For an explicitly synthetic workstation without TWS:

```sh
npm run dev:mock
```

Simulation is labelled in the UI and never activates as a broker fallback.

## Desktop

The desktop app bundles the terminal, packaged SDK, Node, gateway and MCP services.
Customers need TWS and SDK runtime credentials, but no Node installation or npm
credentials. A fresh install starts with setup and does not connect until a profile
is tested and applied. Existing saved profiles reconnect on launch.

For local builds, install Rust and the platform's Tauri prerequisites, then run
`npm run desktop:dev` or `npm run desktop:build`.
See [desktop setup](docs/desktop.md) and [signing and releases](docs/releases.md).

## Agent access

Connect your own MCP client to the endpoint shown in Agent Console. The default
source-development endpoint is `http://127.0.0.1:39182/mcp`; desktop allocates its
own ports. The client manages its AI provider and API credentials. Trading actions
use the mounted SDK authority and the selected connection's permissions and limits.

## Development

```sh
npm run check
npm run build
```

These validate the packaged SDK integration. Browser, desktop and paper-broker
checks are described in [testing](docs/testing.md). Synthetic tests do not establish
IBKR connectivity, market-data entitlement or broker acceptance.

| Directory | Responsibility |
| --- | --- |
| `apps/terminal` | React shell, SDK composition, broker/datafeed adapters and simulation |
| `apps/gateway` | TWS connection, broker operations, authorization and local persistence |
| `apps/mcp` | Local MCP endpoint and authenticated browser bridge |
| `apps/desktop` | Tauri host, bundled Node runtime and same-origin proxy |
| `packages/contracts` | Shared browser/server schemas and wire contracts |
| `packages/service-runtime` | Shared CLI/worker service lifecycle |
| `e2e` | Browser, desktop, simulation and guarded paper-broker scenarios |
| `scripts` | Development, SDK installation and desktop release tooling |
| `docs` | Maintained product, architecture, testing and release documentation |

Start with the [documentation index](docs/README.md) or [contributing guide](CONTRIBUTING.md).
The repository's original code is Apache-2.0 licensed. The SDK is proprietary and
requires separate authorization; see [distribution notices](docs/legal/DISTRIBUTION.md)
and [data handling](docs/legal/DATA.md).
