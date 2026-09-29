# Development

## Setup

Use Node.js 24+ and npm workspaces. Set `TRADESCRIPT_NPM_TOKEN` in the environment,
then run `npm ci` and `npm run dev` from the repository root. The registry setting in
`.npmrc` uses that environment variable; do not replace it with a literal token.
First-run setup accepts SDK runtime credentials separately from package access.

Use `.env.example` for optional overrides. Keep `.env` at mode `0600` on macOS/Linux.
The root launcher owns the gateway, MCP services, loopback capability and same-origin
proxy. Starting the frontend or services independently does not establish this trust.
The development UI origin is `http://localhost:3000` and must match the SDK lease.

## SDK boundary

The stable import is `@tradescript/pro`; the installed alias/version is pinned in
`apps/terminal/package.json` and the lockfile. Current builds use package 0.1.34.
`npm run tradescript:install` validates the package coordinate/version from local
configuration and installs the alias without persisting the npm token.

Authorized SDK developers may set `TRADESCRIPT_SDK_SOURCE` to an external SDK checkout
for `npm run dev`. The repository does not vendor SDK source. Production and desktop
builds always use the installed package. Source mode must not be shipped as a substitute
for a compatible published SDK.

`npm run typecheck:source` checks the terminal and E2E types against the external SDK's
normal declaration output. `npm run check:source` additionally runs formatting and
repository tests. Neither patches installed dependencies. Follow the SDK repository's
own instructions before modifying it; record public-contract issues in [SDK issues](sdk-issues.md).

## State locations

| Environment | Persistent state | SDK credential storage |
| --- | --- | --- |
| Browser/source development | `.local/state`, or `TERMINAL_DATA_DIR` | Owner-only local credential file; `.env` overrides also supported |
| Desktop | OS per-application local data directory | AES-GCM encrypted file; encryption key in macOS Keychain or Windows Credential Manager |
| Isolated E2E/simulation | Test-owned temporary directories | Test configuration; never reuse user desktop state |

The state directory contains the operation journal (`terminal.sqlite`) and saved
profiles (`connections.json`). Browser workspace preferences use the application
origin's storage. Desktop does not load the repository `.env` or `.local`. Losing
its OS encryption key requires restoring access or resetting credentials; do not
silently replace a key while encrypted credentials still exist.

Never commit local state, handoff files, credentials, account data, traces or logs.
Do not stop user processes or touch unrelated broker orders during development.

## Structure and checks

Brand artwork comes from TradeMind's `branding/tradescript-logo.svg`. The terminal's
`public/tradescript-mark.svg` and `public/favicon.svg` use that repository's generated
website assets. Desktop `icons/app-icon.svg` uses its generated native icon framing;
only the outer accessibility title is added here. Preserve the original paths and
gradients. Regenerate desktop PNG, ICNS and ICO files with Tauri's `icon` command
from that SVG, copying only the desktop outputs into `apps/desktop/src-tauri/icons`.

Keep shared wire schemas in `packages/contracts`, service lifecycle code in
`packages/service-runtime`, and application-specific behavior in its owning app.
Small domain modules are preferable to moving asynchronous state between unrelated
owners. Gateway and MCP tests use `test/`; terminal and desktop TypeScript unit tests
are colocated with their modules. Cross-process/browser scenarios live in `e2e/`.

Run the complete affected test file, then `npm run check`. Run `npm run build` for
integration or packaging changes. See [testing](testing.md) for runtime verification.
