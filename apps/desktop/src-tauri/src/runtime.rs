use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

/// Own the child immediately after spawn, including all failed-startup paths.
pub struct Runtime(Arc<Mutex<Option<Child>>>, Arc<Mutex<Option<&'static str>>>);

fn service_diagnostic(line: &str) -> Option<&'static str> {
    let failure = line.strip_prefix("TERMINAL_SERVICE_FAILURE ")?;
    let (phase, code) = failure.split_once(':')?;
    if !matches!(phase, "startup" | "shutdown") {
        return None;
    }
    match code {
        "address-in-use" => Some("A local service port is already in use."),
        "permission-denied" => {
            Some("The operating system denied access to a local service resource.")
        }
        "root-launch-required" => Some("Start the workstation with the root launcher."),
        "invalid-mcp-port" => Some("The configured MCP ports are invalid."),
        "origin-port-mismatch" => Some("The configured UI origin and port do not match."),
        "non-loopback-host" => Some("A local service host is not configured for loopback."),
        "agent-settings-incomplete" => Some("Agent paper trading settings are incomplete."),
        "authorization-settings-incomplete" => {
            Some("TradeScript authorization settings are incomplete.")
        }
        "invalid-environment" => Some("The workstation configuration is invalid."),
        "unknown-error" => Some("A local service failed. Private error details were suppressed."),
        _ => None,
    }
}

impl Runtime {
    pub fn spawn(
        command: &mut Command,
        settings: &serde_json::Value,
    ) -> Result<(Self, mpsc::Receiver<String>), Box<dyn std::error::Error>> {
        let runtime = Self(
            Arc::new(Mutex::new(Some(command.spawn()?))),
            Arc::new(Mutex::new(None)),
        );
        let (send, receive) = mpsc::channel();
        {
            let mut guard = runtime.0.lock().map_err(|_| "Runtime lock failed")?;
            let child = guard.as_mut().ok_or("Missing runtime child")?;
            // Never write private broker/runtime data to an unprotected log.
            let errors = child.stderr.take().ok_or("Missing runtime stderr")?;
            let diagnostic = Arc::clone(&runtime.1);
            std::thread::spawn(move || {
                for line in BufReader::new(errors).lines().map_while(Result::ok) {
                    if let Some(message) = service_diagnostic(&line) {
                        if let Ok(mut latest) = diagnostic.lock() {
                            *latest = Some(message);
                        }
                    }
                }
            });
            let output = child.stdout.take().ok_or("Missing runtime output")?;
            std::thread::spawn(move || {
                for line in BufReader::new(output).lines().map_while(Result::ok) {
                    if let Some(url) = line.strip_prefix("TERMINAL_READY ") {
                        let _ = send.send(url.to_string());
                    }
                }
            });
            writeln!(
                child.stdin.as_mut().ok_or("Missing runtime input")?,
                "{settings}"
            )?;
        }
        Ok((runtime, receive))
    }

    pub fn failure_message(&self) -> String {
        if let Ok(diagnostic) = self.1.lock() {
            if let Some(message) = *diagnostic {
                return message.to_string();
            }
        }
        if let Ok(mut child) = self.0.lock() {
            if let Some(child) = child.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    return match status.code() {
                        Some(code) => format!("The local service stopped (exit code {code})."),
                        None => {
                            "The local service was terminated by the operating system.".to_string()
                        }
                    };
                }
            }
        }
        "Local services could not start in time. Check whether another desktop instance is running."
            .to_string()
    }

    pub fn on_unexpected_exit(&self, on_exit: impl Fn(String) + Send + 'static) {
        let child = Arc::clone(&self.0);
        let diagnostic = Arc::clone(&self.1);
        std::thread::spawn(move || loop {
            let status = match child.lock() {
                Ok(mut guard) => match guard.as_mut() {
                    Some(child) => child.try_wait().ok().flatten(),
                    None => return, // stop() took ownership: this shutdown is expected.
                },
                Err(_) => return,
            };
            if let Some(status) = status {
                let message = diagnostic
                    .lock()
                    .ok()
                    .and_then(|value| *value)
                    .map(str::to_string)
                    .unwrap_or_else(|| match status.code() {
                        Some(code) => format!("The local service stopped (exit code {code})."),
                        None => {
                            "The local service was terminated by the operating system.".to_string()
                        }
                    });
                on_exit(message);
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        });
    }

    pub fn stop(&self) {
        self.stop_with_timeout(Duration::from_secs(5));
    }

    fn stop_with_timeout(&self, timeout: Duration) {
        if let Ok(mut lock) = self.0.lock() {
            if let Some(mut child) = lock.take() {
                if let Some(mut input) = child.stdin.take() {
                    let _ = writeln!(input, "stop");
                }
                let deadline = std::time::Instant::now() + timeout;
                loop {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn native_owner_sends_configuration_and_waits_for_graceful_cleanup() {
        let marker =
            std::env::temp_dir().join(format!("terminal-native-cleanup-{}", std::process::id()));
        let mut command = Command::new("sh");
        command.args(["-c", "read config; echo 'TERMINAL_READY http://127.0.0.1:43871'; read stop; test \"$stop\" = stop && echo cleaned > \"$1\"", "test"])
            .arg(&marker).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (runtime, ready) = Runtime::spawn(&mut command, &serde_json::json!({})).unwrap();
        assert_eq!(
            ready.recv_timeout(Duration::from_secs(2)).unwrap(),
            "http://127.0.0.1:43871"
        );
        runtime.stop();
        runtime.stop();
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "cleaned\n");
        std::fs::remove_file(marker).unwrap();
    }

    #[test]
    fn native_owner_reaps_a_child_that_ignores_shutdown() {
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "read config; echo 'TERMINAL_READY test'; while :; do :; done",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (runtime, ready) = Runtime::spawn(&mut command, &serde_json::json!({})).unwrap();
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        runtime.stop_with_timeout(Duration::from_millis(20));
        assert!(runtime.0.lock().unwrap().is_none());
    }

    #[test]
    fn native_owner_notifies_an_unexpected_exit_after_readiness() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "read config; echo 'TERMINAL_READY test'; exit 7"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (runtime, ready) = Runtime::spawn(&mut command, &serde_json::json!({})).unwrap();
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let (send, receive) = mpsc::channel();
        runtime.on_unexpected_exit(move |message| {
            send.send(message).unwrap();
        });
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(2)).unwrap(),
            "The local service stopped (exit code 7)."
        );
    }

    #[test]
    fn native_owner_does_not_report_expected_shutdown_as_failure() {
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "read config; echo 'TERMINAL_READY test'; read stop; exit 0",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (runtime, ready) = Runtime::spawn(&mut command, &serde_json::json!({})).unwrap();
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let (send, receive) = mpsc::channel();
        runtime.on_unexpected_exit(move |message| {
            let _ = send.send(message);
        });
        runtime.stop();
        assert!(receive.recv_timeout(Duration::from_millis(150)).is_err());
    }

    #[test]
    fn native_owner_keeps_only_allowlisted_service_diagnostics() {
        assert_eq!(
            service_diagnostic("TERMINAL_SERVICE_FAILURE startup:address-in-use"),
            Some("A local service port is already in use.")
        );
        for private in [
            "Error: credential=dummy-private-value",
            "TERMINAL_SERVICE_FAILURE startup:address-in-use credential=dummy-private-value",
            "TERMINAL_SERVICE_FAILURE private:address-in-use",
            "TERMINAL_SERVICE_FAILURE startup:dummy-private-value",
        ] {
            assert!(service_diagnostic(private).is_none());
        }
        let mut command = Command::new("sh");
        command.args(["-c", "read config; echo 'credential=dummy-private-value' >&2; echo 'TERMINAL_SERVICE_FAILURE startup:origin-port-mismatch' >&2; echo 'TERMINAL_READY test'; read stop"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (runtime, ready) = Runtime::spawn(&mut command, &serde_json::json!({})).unwrap();
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while runtime.1.lock().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            runtime.failure_message(),
            "The configured UI origin and port do not match."
        );
    }
}
