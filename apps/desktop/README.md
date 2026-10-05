# Desktop application

| Directory/file | Ownership |
| --- | --- |
| `src-tauri/src/main.rs` | Native application setup, menu/window integration, credentials and updater commands |
| `src-tauri/src/runtime.rs` | Owned Node child startup, readiness and shutdown |
| `src/runtime.ts` | Compose the packaged local runtime |
| `src/service-workers.ts` | Gateway/MCP worker readiness, failure detection and cleanup |
| `src/proxy.ts` | Stable loopback origin and authenticated same-origin proxy |
| `src-tauri/icons` | Generated desktop icon assets; regenerate with `npm run desktop:icons` |
| `shell` | Native shell frontend assets |

Use root `npm run desktop:dev` for the native window with hot reload. Tauri starts
the root `npm run dev` workstation and opens `http://localhost:3000`; frontend
edits update through Vite, and Rust edits rebuild and reopen the native window.
Development uses the repository environment and source-development state, including
`TRADESCRIPT_SDK_SOURCE`, `TERMINAL_ENV_FILE`, and `TERMINAL_DATA_DIR` overrides.
An optional `.local/desktop-dev/dev.env` is selected automatically when no explicit
environment override is provided. On macOS, a lightweight
`.local/desktop-dev/IBKR Tradescript Terminal Dev.app` wraps the debug executable with
its app identity and icon; it is not installed in Applications.

Use root `npm run desktop:build` to prepare and package the frontend, Node runtime,
and SDK for installation. Packaged builds retain their separate loopback origin,
app-local state, and OS-keychain credentials. Generated runtime, binaries, Rust
build outputs and release configuration are ignored. Do not commit them.

See [desktop setup](../../docs/desktop.md), [architecture](../../docs/architecture.md),
[testing](../../docs/testing.md) and [release requirements](../../docs/releases.md).
