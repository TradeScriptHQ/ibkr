#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use serde::Serialize;
use std::{
    process::{Command, Stdio},
    time::Duration,
};
mod about_menu;
mod credential_page;
mod runtime;
mod workspace_windows;
use runtime::Runtime;
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

const RELOAD_APP_MENU_ID: &str = "reload-app";

fn foreground_terminal(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        app.show()?;
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

fn development_url(config: &tauri::Config) -> Result<Option<tauri::Url>, &'static str> {
    #[cfg(debug_assertions)]
    {
        let Some(url) = config.build.dev_url.as_ref() else {
            return Ok(None);
        };
        if url.as_str() != "http://localhost:3000/" {
            return Err(
                "Desktop development must use the root workstation at http://localhost:3000",
            );
        }
        Ok(Some(url.clone()))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = config;
        Ok(None)
    }
}

fn navigation_allowed(url: &tauri::Url, origin: &tauri::Url) -> bool {
    url.origin() == origin.origin() && url.username().is_empty() && url.password().is_none()
}

fn create_main_window(app: &tauri::App, url: tauri::Url) -> tauri::Result<()> {
    let origin = url.clone();
    let popout_origin = url.clone();
    let popout_app = app.handle().clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(&app.package_info().name)
        .inner_size(1440.0, 960.0)
        .min_inner_size(900.0, 600.0)
        // Tauri's native file-drop handler claims every drag, so the page would never
        // receive dragover/drop and workspace tabs could not be rearranged.
        .disable_drag_drop_handler()
        .on_navigation(move |url| navigation_allowed(url, &origin))
        .on_new_window(move |url, features| {
            workspace_windows::open(&popout_app, url, features, &popout_origin)
        });
    #[cfg(target_os = "macos")]
    let window = window
        .transparent(true)
        .theme(Some(tauri::Theme::Dark))
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // Align the native button centers with the 40px workstation toolbar.
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 26.0))
        .effects(tauri::utils::config::WindowEffectsConfig {
            effects: vec![tauri::utils::WindowEffect::HudWindow],
            state: Some(tauri::utils::WindowEffectState::Active),
            ..Default::default()
        });
    #[cfg(windows)]
    let window = window.decorations(false);
    window.build()?;
    Ok(())
}

#[cfg(test)]
mod update_permissions;

#[cfg(test)]
mod development_permissions;

fn credential_service(config: &tauri::Config) -> &str {
    &config.identifier
}

fn credential_key(service: &str) -> Result<String, Box<dyn std::error::Error>> {
    let entry = keyring::Entry::new(service, "credential-encryption")?;
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
    if let Some(runtime) = app.try_state::<Runtime>() {
        runtime.stop();
    }
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

fn main() {
    let context = tauri::generate_context!();
    let product_name = context.package_info().name.clone();
    let app = tauri::Builder::default()
        .menu(|app| {
            let menu = Menu::default(app)?;
            about_menu::install(app, &menu)?;
            let reload = MenuItem::with_id(
                app,
                RELOAD_APP_MENU_ID,
                "Reload app",
                true,
                Some("CmdOrCtrl+Shift+R"),
            )?;
            for item in menu.items()? {
                if let Some(submenu) = item.as_submenu() {
                    if submenu.text()? == "View" {
                        submenu.prepend(&reload)?;
                        return Ok(menu);
                    }
                }
            }
            let view = Submenu::with_items(app, "View", true, &[&reload])?;
            menu.insert(&view, menu.items()?.len().saturating_sub(2))?;
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == RELOAD_APP_MENU_ID {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.reload();
                }
            } else if event.id().as_ref() == about_menu::MENU_ID {
                let _ = foreground_terminal(app);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.dispatchEvent(new Event('terminal:about'))");
                }
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = foreground_terminal(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            check_update,
            install_update,
            credential_page::open_credentials_page
        ])
        .setup(|app| {
            if let Some(url) = development_url(app.config())? {
                // The root launcher owns development services and their capability.
                // Attaching the native window must not create a second packaged runtime.
                create_main_window(app, url)?;
                return Ok(());
            }
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
            let key = credential_key(credential_service(app.config()))?;
            let (runtime, receive) = Runtime::spawn(
                &mut command,
                &serde_json::json!({ "dataDir": data, "credentialKey": key }),
            )?;
            let url = receive.recv_timeout(Duration::from_secs(30))
                .map_err(|_| runtime.failure_message())?;
            if url != "http://127.0.0.1:43871" {
                return Err("Unexpected local service address".into());
            }
            let app_handle = app.handle().clone();
            let on_runtime_exit = move |message| {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let product_name = &app_handle.package_info().name;
                    let _ = window.set_title(&format!("{product_name} · local services stopped"));
                    // Fixed guidance and a bounded reason code; never render raw stderr or settings.
                    let notice = serde_json::to_string(&format!(
                        "{message} Close and reopen {product_name} to reconnect."
                    )).unwrap_or_else(|_| "\"The local service stopped. Reopen the application.\"".into());
                    let _ = window.eval(&format!(
                        "document.body.replaceChildren(Object.assign(document.createElement('main'), {{textContent: {notice}, style: 'padding:48px;font:18px system-ui;line-height:1.6;color:#eee;background:#15181d;min-height:100vh'}}));"
                    ));
                }
            };
            app.manage(runtime);
            create_main_window(app, url.parse()?)?;
            app.state::<Runtime>().on_unexpected_exit(on_runtime_exit);
            Ok(())
        })
        .build(context)
        .expect(&format!("Could not start {product_name}"));
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(runtime) = handle.try_state::<Runtime>() {
                runtime.stop();
            }
        }
    });
}

#[cfg(test)]
mod development_tests {
    use super::{development_url, navigation_allowed};

    #[test]
    fn desktop_does_not_register_console_account_callbacks() {
        let config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(!config.plugins.0.contains_key("deep-link"));
    }

    #[test]
    fn default_bundle_still_starts_its_own_runtime() {
        let config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(development_url(&config).unwrap(), None);
    }

    #[test]
    #[cfg(debug_assertions)]
    fn development_attaches_only_to_the_root_workstation() {
        let mut config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        config.build.dev_url = Some("http://localhost:3000".parse().unwrap());
        assert_eq!(development_url(&config).unwrap(), config.build.dev_url);
        for address in [
            "http://127.0.0.1:3000",
            "http://localhost:3001",
            "https://localhost:3000",
            "http://localhost:3000/other",
            "http://user@localhost:3000",
            "http://example.com:3000",
        ] {
            config.build.dev_url = Some(address.parse().unwrap());
            assert!(development_url(&config).is_err(), "{address}");
        }
    }

    #[test]
    fn both_windows_keep_navigation_on_their_own_origin() {
        for address in ["http://127.0.0.1:43871", "http://localhost:3000"] {
            let origin: tauri::Url = address.parse().unwrap();
            assert!(navigation_allowed(
                &origin.join("/trading").unwrap(),
                &origin
            ));
            for blocked in [
                "http://localhost:3001",
                "https://localhost:3000",
                "http://example.com",
                "http://user@localhost:3000",
            ] {
                assert!(
                    !navigation_allowed(&blocked.parse().unwrap(), &origin),
                    "{blocked}"
                );
            }
            let other: tauri::Url = if address.contains("43871") {
                "http://localhost:3000".parse().unwrap()
            } else {
                "http://127.0.0.1:43871".parse().unwrap()
            };
            assert!(!navigation_allowed(&other, &origin));
        }
    }
}

#[cfg(test)]
mod credential_isolation_tests {
    use super::credential_service;

    #[test]
    fn primary_bundle_retains_its_existing_credential_service() {
        let config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(credential_service(&config), "dev.tradescript.ibkr-terminal");
    }

    #[test]
    fn separate_bundle_uses_a_separate_credential_service() {
        let mut config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        config.identifier = "dev.tradescript.ibkr-terminal.qualification".into();
        assert_eq!(
            credential_service(&config),
            "dev.tradescript.ibkr-terminal.qualification"
        );
        assert_ne!(credential_service(&config), "dev.tradescript.ibkr-terminal");
    }
}
