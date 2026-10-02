#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use serde::Serialize;
use std::{
    process::{Command, Stdio},
    time::Duration,
};
mod account;
mod runtime;
use account::{open_tradescript_console, terminal_open_requests};
use runtime::Runtime;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

#[cfg(test)]
mod update_permissions;

fn credential_key() -> Result<String, Box<dyn std::error::Error>> {
    let entry = keyring::Entry::new("dev.tradescript.ibkr-terminal", "credential-encryption")?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            let key = STANDARD.encode(bytes);
            entry.set_password(&key)?;
            Ok(key)
        }
        Err(error) => Err(error.into()),
    }
}

#[derive(Serialize)]
struct UpdateStatus {
    configured: bool,
    version: Option<String>,
    notes: Option<String>,
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let configured = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .is_some_and(|v| !v.is_empty());
    if !configured {
        return Ok(UpdateStatus {
            configured: false,
            version: None,
            notes: None,
        });
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(UpdateStatus {
        configured: true,
        version: update.as_ref().map(|u| u.version.clone()),
        notes: update.and_then(|u| u.body),
    })
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No update available")?;
    if update.version != version {
        return Err("The release changed. Check for updates again.".into());
    }
    // Verify the download before stopping the bridge for installation.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.state::<Runtime>().stop();
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            check_update,
            install_update,
            open_tradescript_console,
            terminal_open_requests
        ])
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            let data = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let executable = std::env::current_exe()?
                .parent()
                .ok_or("Missing executable directory")?
                .join(if cfg!(windows) {
                    "terminal-node.exe"
                } else {
                    "terminal-node"
                });
            // tauri dev uses the target-suffixed binary from the preparation step.
            let executable = if executable.exists() {
                executable
            } else {
                let binaries = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
                std::fs::read_dir(binaries)?
                    .filter_map(Result::ok)
                    .find(|e| {
                        e.file_name()
                            .to_string_lossy()
                            .starts_with("terminal-node-")
                    })
                    .ok_or("Run npm run desktop:prepare first")?
                    .path()
            };
            let runtime = resources.join("runtime/runtime.mjs");
            let runtime = if runtime.exists() {
                runtime
            } else {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime/runtime.mjs")
            };
            let mut command = Command::new(executable);
            command
                .arg(runtime)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let key = credential_key()?;
            let (runtime, receive) = Runtime::spawn(
                &mut command,
                &serde_json::json!({ "dataDir": data, "credentialKey": key }),
            )?;
            let url = receive.recv_timeout(Duration::from_secs(30)).map_err(|_| {
                "Local services could not start. Check whether port 43871 is already in use."
            })?;
            if url != "http://127.0.0.1:43871" {
                return Err("Unexpected local service address".into());
            }
            app.manage(runtime);
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("TradeScript Terminal")
                .inner_size(1440.0, 960.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(|url| {
                    url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(43871)
                });
            #[cfg(target_os = "macos")]
            let window = window
                .transparent(true)
                .theme(Some(tauri::Theme::Dark))
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(18.0, 22.0))
                .effects(tauri::utils::config::WindowEffectsConfig {
                    effects: vec![tauri::utils::WindowEffect::HudWindow],
                    state: Some(tauri::utils::WindowEffectState::Active),
                    ..Default::default()
                });
            #[cfg(windows)]
            let window = window.decorations(false);
            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start TradeScript Terminal");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<Runtime>().stop();
        }
    });
}
