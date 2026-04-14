//! SSH client core — connect / authenticate / exec.
//!
//! This is the first milestone where all the lower layers (db, secrets,
//! known_hosts) come together in one outbound network call. The MVP surface
//! here is deliberately small:
//!
//! - [`ProsshHandler`] implements [`russh::client::Handler`] and wires host
//!   key verification into our [`KnownHostsStore`]. On first sight of an
//!   unknown host it applies **trust-on-first-use**: the fingerprint is saved
//!   to the store with a `"Auto-accepted via Test connect (TOFU)"` comment.
//!   A real user-facing prompt lands in step 9 together with the
//!   `HostKeyGate` machinery.
//! - [`test_connect`] opens a TCP socket, does the SSH handshake, authenticates
//!   with a password, runs a single command and returns the captured output.
//!   It exists so the UI can offer a "Test" button on each saved session to
//!   verify credentials end-to-end before we ship a full PTY terminal in
//!   step 6.

pub mod auth;
pub mod config;
pub mod forward;
pub mod gate;
pub mod import_moba;
pub mod import_putty;
pub mod pty;

use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use parking_lot::Mutex;
use serde::Serialize;

use crate::error::AppError;
use crate::known_hosts::{HostKeyMatch, KnownHostEntry, KnownHostsStore};

/// How the host key check resolved during the connect handshake.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostKeyStatus {
    /// Fingerprint matched an existing entry in the known-hosts store.
    Trusted,
    /// No previous entry; the fingerprint was auto-added (TOFU). The user
    /// should see this as a one-time banner on the Test result.
    NewlyAdded,
    /// An entry exists for this host:port:algorithm but the fingerprint is
    /// different. Connect was refused; `stored` is the previous fingerprint.
    Mismatch { stored: String },
}

/// Details surfaced about the server's host key after a successful handshake.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyReport {
    pub algorithm: String,
    pub fingerprint: String,
    pub status: HostKeyStatus,
}

/// Result of running [`test_connect`] against a live server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub host_key: HostKeyReport,
    pub exit_code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u64,
}

/// russh Handler that plugs into [`KnownHostsStore`] for host key verification.
///
/// The handler is consumed by `russh::client::connect(...)` and we can't get
/// it back out of the returned `Handle`, so we share a `Mutex<Option<...>>`
/// with the caller to communicate the key-check outcome.
pub struct ProsshHandler {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) known_hosts: Arc<KnownHostsStore>,
    pub(crate) report: Arc<Mutex<Option<HostKeyReport>>>,
    /// When present, unknown host keys trigger a user prompt via the gate
    /// instead of the step-5 TOFU auto-accept. Mismatch is always rejected.
    pub(crate) host_key_gate: Option<gate::PromptMap<bool>>,
    /// Channel to send HostKeyPrompt status events to the frontend.
    pub(crate) status_channel: Option<tauri::ipc::Channel<pty::SshStatus>>,
}

impl ProsshHandler {
    fn debug_log(msg: &str) {
        if let Some(desktop) = dirs::desktop_dir() {
            let _ = std::fs::OpenOptions::new()
                .create(true).append(true)
                .open(desktop.join("prossh-debug.log"))
                .and_then(|mut f| {
                    use std::io::Write;
                    writeln!(f, "[{}] {msg}", chrono::Local::now().format("%H:%M:%S%.3f"))
                });
        }
    }
}

impl russh::client::Handler for ProsshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let algorithm = server_public_key.algorithm().as_str().to_string();
        let fingerprint = server_public_key
            .fingerprint(Default::default())
            .to_string();

        let verdict = self
            .known_hosts
            .check(&self.host, self.port, &algorithm, &fingerprint);

        match verdict {
            HostKeyMatch::Match => {
                *self.report.lock() = Some(HostKeyReport {
                    algorithm,
                    fingerprint,
                    status: HostKeyStatus::Trusted,
                });
                Ok(true)
            }
            HostKeyMatch::Mismatch { stored, .. } => {
                tracing::warn!(
                    host = %self.host, port = self.port, algorithm = %algorithm,
                    stored = %stored, incoming = %fingerprint,
                    "host key mismatch — refusing connection"
                );
                *self.report.lock() = Some(HostKeyReport {
                    algorithm,
                    fingerprint,
                    status: HostKeyStatus::Mismatch { stored },
                });
                // Returning Ok(false) tells russh to abort the handshake with
                // an UnknownKey/HostKeyNotVerifiable error — which we then
                // translate into a specific "mismatch" error in test_connect.
                Ok(false)
            }
            HostKeyMatch::Unknown => {
                Self::debug_log("check_server_key: Unknown host key, will prompt");
                // If we have a gate, prompt the user; otherwise TOFU.
                let accepted = if let (Some(gate_map), Some(status_ch)) =
                    (&self.host_key_gate, &self.status_channel)
                {
                    let (prompt_id, rx) = gate::register(gate_map).await;
                    Self::debug_log(&format!("check_server_key: registered gate prompt_id={prompt_id}"));
                    let send_result = status_ch.send(pty::SshStatus::HostKeyPrompt {
                        prompt_id,
                        host: self.host.clone(),
                        port: self.port,
                        algorithm: algorithm.clone(),
                        fingerprint: fingerprint.clone(),
                    });
                    Self::debug_log(&format!("check_server_key: sent HostKeyPrompt to frontend, result={send_result:?}"));
                    Self::debug_log("check_server_key: waiting for rx.await...");
                    let result = rx.await;
                    Self::debug_log(&format!("check_server_key: rx.await returned {result:?}"));
                    result.unwrap_or(false)
                } else {
                    // Step 5 TOFU fallback (test_connect)
                    true
                };

                if accepted {
                    let entry = KnownHostEntry {
                        host: self.host.clone(),
                        port: self.port,
                        algorithm: algorithm.clone(),
                        fingerprint: fingerprint.clone(),
                        comment: Some("Accepted by user".into()),
                        added_at: Utc::now(),
                    };
                    // Update in-memory store immediately (fast, no I/O).
                    self.known_hosts.add_memory(entry);
                    // Persist to disk on a blocking thread so we don't stall
                    // the async SSH handshake with file I/O.
                    let kh = self.known_hosts.clone();
                    tokio::task::spawn_blocking(move || {
                        if let Err(e) = kh.persist() {
                            // Append to desktop log for debugging
                            if let Some(desktop) = dirs::desktop_dir() {
                                let _ = std::fs::OpenOptions::new()
                                    .create(true).append(true)
                                    .open(desktop.join("prossh-debug.log"))
                                    .and_then(|mut f| {
                                        use std::io::Write;
                                        writeln!(f, "persist error: {e}")
                                    });
                            }
                        }
                    });
                    *self.report.lock() = Some(HostKeyReport {
                        algorithm,
                        fingerprint,
                        status: HostKeyStatus::NewlyAdded,
                    });
                    Ok(true)
                } else {
                    *self.report.lock() = Some(HostKeyReport {
                        algorithm,
                        fingerprint,
                        status: HostKeyStatus::Mismatch {
                            stored: "(rejected by user)".into(),
                        },
                    });
                    Ok(false)
                }
            }
        }
    }
}

/// One-shot connect → auth → exec → disconnect probe.
///
/// Runs a single command (default `whoami`) against a live server so the
/// frontend can verify credentials from the session edit dialog. Any error
/// is returned as [`AppError::Ssh`] with a human-readable message.
pub async fn test_connect(
    known_hosts: Arc<KnownHostsStore>,
    host: String,
    port: u16,
    username: String,
    password: String,
    command: String,
) -> Result<SshTestResult, AppError> {
    let started = Instant::now();
    let report = Arc::new(Mutex::new(None::<HostKeyReport>));

    let handler = ProsshHandler {
        host: host.clone(),
        port,
        known_hosts,
        report: report.clone(),
        host_key_gate: None,
        status_channel: None,
    };

    let config = Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(20)),
        keepalive_interval: Some(Duration::from_secs(10)),
        keepalive_max: 3,
        ..Default::default()
    });

    // --- TCP + SSH handshake (includes check_server_key callback) -----------
    let connect = russh::client::connect(config, (host.as_str(), port), handler);
    let mut session = match tokio::time::timeout(Duration::from_secs(15), connect).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            // Prefer the more specific host-key error if the handler flagged one.
            if let Some(HostKeyReport {
                status: HostKeyStatus::Mismatch { stored },
                fingerprint,
                ..
            }) = report.lock().clone()
            {
                return Err(AppError::Ssh(format!(
                    "host key mismatch for {host}:{port} — server now presents {fingerprint}, \
                     we trusted {stored}. Revoke the old entry in Settings → Known hosts \
                     if this rotation is legitimate."
                )));
            }
            return Err(AppError::Ssh(format!("connect: {e}")));
        }
        Err(_) => {
            return Err(AppError::Ssh(format!(
                "TCP/SSH handshake with {host}:{port} timed out after 15s"
            )))
        }
    };

    let host_key = report
        .lock()
        .clone()
        .ok_or_else(|| AppError::Ssh("server did not present a host key".into()))?;

    // --- Password auth ------------------------------------------------------
    let auth = session
        .authenticate_password(username, password)
        .await
        .map_err(|e| AppError::Ssh(format!("authenticate_password: {e}")))?;
    if !auth.success() {
        let _ = session
            .disconnect(russh::Disconnect::ByApplication, "auth failed", "en")
            .await;
        return Err(AppError::Ssh(
            "authentication failed — check username / password".into(),
        ));
    }

    // --- Open a session channel and exec the probe command -----------------
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("channel_open_session: {e}")))?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

    let mut stdout: Vec<u8> = Vec::with_capacity(256);
    let mut stderr: Vec<u8> = Vec::with_capacity(64);
    let mut exit_code: Option<u32> = None;

    loop {
        match tokio::time::timeout(Duration::from_secs(10), channel.wait()).await {
            Ok(Some(msg)) => match msg {
                russh::ChannelMsg::Data { ref data } => {
                    stdout.extend_from_slice(&data[..]);
                }
                russh::ChannelMsg::ExtendedData { ref data, ext: _ } => {
                    stderr.extend_from_slice(&data[..]);
                }
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = Some(exit_status);
                    // Don't break yet — the server usually sends Eof/Close right after.
                }
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            },
            Ok(None) => break,
            Err(_) => {
                let _ = session
                    .disconnect(russh::Disconnect::ByApplication, "exec timeout", "en")
                    .await;
                return Err(AppError::Ssh(format!(
                    "command {command:?} did not finish within 10s"
                )));
            }
        }
    }

    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "done", "en")
        .await;

    Ok(SshTestResult {
        host_key,
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
