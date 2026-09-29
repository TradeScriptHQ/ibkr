# Desktop setup

The Tauri application bundles the same terminal frontend and proprietary SDK as
the web application, plus Node and the local gateway/MCP services. No npm token or
Node installation is needed on customer machines. TWS is installed separately.

## Build locally

Install Node 24+, Rust stable, and the Tauri prerequisites for your platform
(Xcode command-line tools on macOS; Visual Studio C++ build tools on Windows).
After npm authentication and `npm ci`, run:

```sh
npm run desktop:dev
npm run desktop:build
```

Desktop builds always use the packaged SDK 0.1.34. `TRADESCRIPT_SDK_SOURCE` remains
available for `npm run dev` web/source testing; it is never included in releases.
The preparation script downloads official Node 24.21.0 and verifies its SHA-256
checksum. It never packages a Homebrew executable with external library dependencies. Build on each target platform/architecture.

The UI is served on `http://127.0.0.1:43871`. SDK credentials must be entitled for
that origin. The gateway and MCP services use separate allocated loopback ports;
the Agent Console advertises the actual MCP endpoint. No production credentials
or root `.env` are copied to a desktop build. A fresh installation does not connect
to TWS until the user tests and applies a connection. Existing desktop profiles
reconnect on launch.

The desktop app is self-contained and does not share web/source state. It reads no
repository `.env` and never touches `.local`; the Tauri shell passes its
`app_local_data_dir` to the runtime as `TERMINAL_DATA_DIR` and sets
`TERMINAL_DESKTOP=1`, so the gateway skips the root `.env` and uses the OS-keychain
credential store. Web and source development instead use `.local/state`
(`TERMINAL_DATA_DIR` override) and the repository `.env`. A fresh desktop install
is therefore unconfigured and shows first-run setup until credentials and a
connection are saved.

macOS uses Keychain; Windows uses Credential Manager for the credential encryption
key. SDK secrets are AES-GCM encrypted in app-local data. Losing the OS key means
restoring it or resetting credentials; do not silently replace an existing key.
Workspace webview storage persists at the stable origin. Closing the window stops
owned local services, never TWS and never broker orders.

## Recover SDK access

The app checks SDK authorization every five seconds and when its window regains
focus. A check also starts any renewal whose timer was missed, for example while
the computer slept; the workstation stays open while that renewal is in progress.
If renewal is rejected while the current authorization is still valid, a
notice offers **Update SDK credentials** without closing the workstation. Once
authorization expires after a failed renewal, the app shows **Restore SDK access**
with replacement fields, including when TWS setup has not been completed.

Use new runtime credentials from Developer Console, or choose **Retry authorization**
after renewing a licence or restoring connectivity. Network failures are shown
separately from rejected credentials. Replacement credentials are validated before
the encrypted saved credentials are overwritten; a failed attempt preserves the
existing credentials. Success reloads an already-configured workstation. TWS profiles
and saved workspace data are retained; this flow does not cancel broker orders.
If the local session itself has expired, **Reload workstation** starts a fresh local
session and returns to credential recovery without deleting saved settings.

## Runtime ownership

The Rust host owns one Node child. The Node runtime owns the authenticated proxy and
gateway/MCP workers. Readiness is explicit; an unexpected worker exit stops the owned
runtime. Shutdown asks owned services to close before terminating an unresponsive
child. It never stops TWS or cancels broker orders.

See [architecture](architecture.md) for owners, [testing](testing.md) for automated
checks, and [releases](releases.md) for platform signing, updater keys, publication
and clean-machine acceptance. The loopback browser E2E is separate from verifying
the native window and installed application.

### Window appearance

The macOS app uses native behind-window vibrancy and an overlay title bar with the system window controls. The web view, workstation shell, and chart theme use translucent surfaces so the desktop material remains visible throughout the app. Dialogs retain stronger contrast for readability. Reduced transparency and increased contrast preferences use an opaque background.

Windows uses the custom title bar with minimize, maximize/restore, and close controls, with an opaque dark fallback. Browser sessions retain their normal browser chrome. Window commands are restricted to the main window at the bundled loopback origin.
