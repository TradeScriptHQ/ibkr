use std::process::Command;
use tauri_plugin_deep_link::DeepLinkExt;

fn console_url_allowed(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("console.tradescript.dev")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && matches!(url.path(), "/login" | "/app" | "/app/billing")
}

#[tauri::command]
pub async fn open_tradescript_console(url: String) -> Result<(), String> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|_| "Invalid TradeScript Console link.")?;
    if !console_url_allowed(&parsed) {
        return Err("This link is not a supported TradeScript Console destination.".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.args(["--", parsed.as_str()]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", parsed.as_str()]);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(parsed.as_str());
        command
    };
    command
        .status()
        .map_err(|_| "Could not open your browser. Please open TradeScript Console.".to_string())?
        .success()
        .then_some(())
        .ok_or_else(|| "Could not open your browser. Please open TradeScript Console.".into())
}

#[tauri::command]
pub fn terminal_open_requests(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    app.deep_link()
        .get_current()
        .map(|urls| {
            urls.unwrap_or_default()
                .into_iter()
                .map(|url| url.to_string())
                .collect()
        })
        .map_err(|_| "Could not read the app-opening request.".into())
}

#[cfg(test)]
mod tests {
    use super::console_url_allowed;

    #[test]
    fn browser_links_are_restricted_to_the_real_console_and_supported_paths() {
        for url in [
            "https://console.tradescript.dev/login?mode=trader&native=1&callback_port=53214",
            "https://console.tradescript.dev/login?mode=trader&plan=individual",
            "https://console.tradescript.dev/app",
        ] {
            assert!(console_url_allowed(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "http://console.tradescript.dev/login",
            "https://console.tradescript.dev.evil.test/login",
            "https://console.tradescript.dev:8443/login",
            "https://user@console.tradescript.dev/login",
            "https://console.tradescript.dev/login#secret",
            "file:///etc/passwd",
            "https://console.tradescript.dev/api/v1/terminal/license",
        ] {
            assert!(!console_url_allowed(&url.parse().unwrap()), "{url}");
        }
    }

    #[test]
    fn account_commands_are_available_only_to_the_native_workstation() {
        use tauri::utils::{
            acl::{resolved::Resolved, ExecutionContext},
            platform::Target,
        };
        let manifests =
            serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
        let capabilities =
            serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
        let resolved = Resolved::resolve(&manifests, capabilities, Target::current()).unwrap();
        for command in ["open_tradescript_console", "terminal_open_requests"] {
            let grants = resolved
                .allowed_commands
                .get(command)
                .expect("account command is registered");
            for grant in grants {
                assert!(grant.windows.iter().any(|pattern| pattern.matches("main")));
                let ExecutionContext::Remote { url } = &grant.context else {
                    panic!("account commands must be scoped to the native workstation")
                };
                assert!(url.test(&"http://127.0.0.1:43871/".parse().unwrap()));
                assert!(!url.test(&"https://console.tradescript.dev/".parse().unwrap()));
                assert!(!url.test(&"http://127.0.0.1:43872/".parse().unwrap()));
            }
        }
    }
}
