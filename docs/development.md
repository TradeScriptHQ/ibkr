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
`apps/terminal/package.json` and the lockfile. Current builds use package 0.1.38.
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

### Symbol logos

Set `VITE_LOGO_DEV_PUBLISHABLE_KEY` to your Logo.dev `pk_` key in the root `.env`
for development/local builds, or in the release repository's Actions variables.
The key is intentionally included in the frontend bundle; secret `sk_` keys are
rejected. Without a key, the SDK keeps its initials tiles.

Stock/ETF logos use the ISIN returned by IBKR when available. Known US listings
can use their ticker before ISIN qualification; other listings without an ISIN
keep initials. Crypto uses Logo.dev's crypto lookup. Forex, derivatives and other
unsupported instruments keep initials. Missing logos and failed requests also
use the SDK's existing initials fallback.

Images load directly from Logo.dev with stable URLs. Its
[HTTP cache headers](https://www.logo.dev/docs/platform/caching) allow the desktop
WebView to reuse images for 24 hours. No logo proxy, bulk downloads or separate
disk cache is created. A persistent offline collection would require the
[download API](https://www.logo.dev/docs/platform/self-hosting) with a server-held
secret key. Domain restrictions must allow the development `localhost` and
packaged desktop `127.0.0.1` origins; a restriction with no matching Referer rejects
the image. Individually maintained, noncommercial open-source releases do not
require [attribution](https://www.logo.dev/docs/platform/attribution); commercial
releases using the Community plan require the documented public credit.

### Application state

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

The independent app is named **IBKR Tradescript Terminal**. Its display name comes
from `apps/desktop/src-tauri/tauri.conf.json`; the native window and frontend share
that source. Keep the existing bundle identifier and internal executable/storage
names so the display-name change preserves saved settings and credentials.

The owned `src-tauri/windows/installer.nsi` template keeps the published Windows
installer keys and folders under a separate stable installation identity while
using the new display name. Its contract test pins the upstream Tauri template;
review that source when upgrading the bundler. macOS updates retain the running
app bundle path. A Windows installation/upgrade smoke test is still required
before releasing the renamed installer.

The app's selected red-and-silver ribbon artwork is owned by `apps/desktop/icon.png`.
Run `npm run desktop:icons` after editing it. This generates the native PNG, ICNS
and ICO files, and the terminal's `public/terminal-logo.png`
and `public/favicon.png`. Do not edit those generated outputs. The TradeScript SDK
and its licence retain their own branding.

Keep shared wire schemas in `packages/contracts`, service lifecycle code in
`packages/service-runtime`, and application-specific behavior in its owning app.
Small domain modules are preferable to moving asynchronous state between unrelated
owners. Gateway and MCP tests use `test/`; terminal and desktop TypeScript unit tests
are colocated with their modules. Cross-process/browser scenarios live in `e2e/`.

Run the complete affected test file, then `npm run check`. Run `npm run build` for
integration or packaging changes. See [testing](testing.md) for runtime verification.
