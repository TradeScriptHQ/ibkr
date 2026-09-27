# Desktop application

| Directory/file | Ownership |
| --- | --- |
| `src-tauri/src/main.rs` | Native application setup, menu/window integration, credentials and updater commands |
| `src-tauri/src/runtime.rs` | Owned Node child startup, readiness and shutdown |
| `src/runtime.ts` | Compose the packaged local runtime |
| `src/service-workers.ts` | Gateway/MCP worker readiness, failure detection and cleanup |
| `src/proxy.ts` | Stable loopback origin and authenticated same-origin proxy |
| `src-tauri/icons` | Desktop icon assets; regenerate from `icon.svg` when branding changes |
| `shell` | Native shell frontend assets |

Use root `npm run desktop:dev` or `npm run desktop:build`; both prepare shared code,
the packaged frontend and runtime. Generated runtime, binaries, Rust build outputs
and release configuration are ignored. Do not commit them.

See [desktop setup](../../docs/desktop.md), [architecture](../../docs/architecture.md),
[testing](../../docs/testing.md) and [release requirements](../../docs/releases.md).
