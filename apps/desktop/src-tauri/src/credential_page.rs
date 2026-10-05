use std::{io, process::Command};

const CREDENTIALS_PAGE: &str = "https://console.tradescript.dev/app/deployments/localhost";
const OPEN_FAILED: &str = "Could not open the credentials page in your browser.";

fn browser_command() -> io::Result<Command> {
    #[cfg(target_os = "macos")]
    let command = {
        let mut command = Command::new("/usr/bin/open");
        command.args(["--", CREDENTIALS_PAGE]);
        command
    };
    #[cfg(windows)]
    let command = {
        let mut command = Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", CREDENTIALS_PAGE]);
        command
    };
    #[cfg(target_os = "linux")]
    let command = {
        let mut command = Command::new("xdg-open");
        command.arg(CREDENTIALS_PAGE);
        command
    };
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    return Ok(command);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Opening the credentials page is unsupported on this platform.",
    ))
}

#[tauri::command]
pub(super) async fn open_credentials_page() -> Result<(), String> {
    // The browser receives only this fixed destination. No credential or callback data travel.
    tauri::async_runtime::spawn_blocking(|| {
        let status = browser_command()
            .and_then(|mut command| command.status())
            .map_err(|_| OPEN_FAILED.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(OPEN_FAILED.to_string())
        }
    })
    .await
    .map_err(|_| OPEN_FAILED.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{browser_command, CREDENTIALS_PAGE};

    #[test]
    fn browser_dispatch_uses_the_fixed_destination_without_a_shell() {
        let command = browser_command().unwrap();
        #[cfg(target_os = "macos")]
        {
            assert_eq!(command.get_program(), "/usr/bin/open");
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                vec!["--", CREDENTIALS_PAGE]
            );
        }
        #[cfg(windows)]
        {
            assert_eq!(command.get_program(), "rundll32.exe");
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                vec!["url.dll,FileProtocolHandler", CREDENTIALS_PAGE]
            );
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(command.get_program(), "xdg-open");
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                vec![CREDENTIALS_PAGE]
            );
        }
    }
}
