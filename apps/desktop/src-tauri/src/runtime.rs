use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command},
    sync::{mpsc, Mutex},
    time::Duration,
};

/// Own the child immediately after spawn, including all failed-startup paths.
pub struct Runtime(Mutex<Option<Child>>);

impl Runtime {
    pub fn spawn(
        command: &mut Command,
        settings: &serde_json::Value,
    ) -> Result<(Self, mpsc::Receiver<String>), Box<dyn std::error::Error>> {
        let runtime = Self(Mutex::new(Some(command.spawn()?)));
        let (send, receive) = mpsc::channel();
        {
            let mut guard = runtime.0.lock().map_err(|_| "Runtime lock failed")?;
            let child = guard.as_mut().ok_or("Missing runtime child")?;
            // Never write private broker/runtime data to an unprotected log.
            let errors = child.stderr.take().ok_or("Missing runtime stderr")?;
            std::thread::spawn(move || for _ in BufReader::new(errors).lines() {});
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
}
