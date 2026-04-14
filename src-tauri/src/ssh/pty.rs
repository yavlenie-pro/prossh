//! PTY session management — open / read / write / resize / close.
//!
//! Each active terminal maps to one [`SshSession`] that wraps:
//!
//! - a russh `Handle` for the SSH transport layer
//! - a russh `Channel` opened in PTY-shell mode
//! - an mpsc channel for inbound keystrokes / resize / close commands from the
//!   frontend
//! - a background tokio task (`reader_task`) that ferries PTY output into a
//!   Tauri `Channel<PtyChunk>` so xterm.js can render it in near-real-time
//!
//! The public entry point is [`open`] which performs the full
//! TCP→SSH→auth→PTY→shell handshake and returns a `runtime_id` that the
//! frontend uses to address subsequent `write_to_pty` / `resize_pty` /
//! `close_session` calls.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;

use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::ssh::gate::PromptMap;
use crate::ssh::ProsshHandler;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Chunk of PTY output streamed to the frontend via `tauri::ipc::Channel`.
/// xterm.js consumes this as `Uint8Array`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyChunk {
    pub data: Vec<u8>,
}

/// Session lifecycle events streamed via a second `Channel`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshStatus {
    Connected {
        runtime_id: String,
    },
    Disconnected {
        runtime_id: String,
        reason: String,
    },
    /// Informational: SSH handshake succeeded, now authenticating.
    Authenticating,
    /// The private key is encrypted — the frontend should show a passphrase
    /// dialog and call `resolve_passphrase` with the user's input.
    PassphraseNeeded {
        prompt_id: String,
        key_path: String,
    },
    /// The server's host key is unknown or mismatched (step 9).
    HostKeyPrompt {
        prompt_id: String,
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    /// The backend needs credentials (username / password) from the user.
    /// Reasons: `"no_password"`, `"no_username"`, `"key_rejected"`.
    CredentialsNeeded {
        prompt_id: String,
        username: String,
        reason: String,
    },
}

/// Response to a [`SshStatus::CredentialsNeeded`] prompt.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CredentialsResponse {
    pub username: String,
    pub password: String,
}

/// Credential passed to [`open`] for authentication.
pub enum Credential {
    /// `None` means no password stored — the gate will prompt the user.
    Password(Option<String>),
    Key {
        path: std::path::PathBuf,
        /// Pre-fetched passphrase from keychain, if any. If the key is
        /// encrypted and this is `None`, the gate will prompt the user.
        passphrase: Option<String>,
    },
}

/// Extra info returned by [`open`] so the caller can persist credentials.
pub struct OpenOutcome {
    pub session: Arc<SshSession>,
    /// Password entered by the user during the prompt (for caller to save).
    pub prompted_password: Option<String>,
    /// Username entered/changed by the user (for caller to save).
    pub prompted_username: Option<String>,
    /// `true` when key auth failed and password auth was used as fallback.
    pub key_auth_fallback: bool,
}

/// Frontend → Rust message for a running PTY.
pub enum PtyIn {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// A live SSH session with an open PTY channel.
pub struct SshSession {
    pub runtime_id: String,
    pub session_id: String,
    pub writer_tx: mpsc::UnboundedSender<PtyIn>,
    pub reader_task: JoinHandle<()>,
    handle: russh::client::Handle<ProsshHandler>,
}

impl SshSession {
    /// Open a `direct-tcpip` channel through this session's SSH transport.
    /// Used by port forwarding to tunnel TCP connections.
    pub async fn channel_open_direct_tcpip(
        &self,
        host: &str,
        port: u32,
        originator: &str,
        originator_port: u32,
    ) -> Result<russh::Channel<russh::client::Msg>, AppError> {
        self.handle
            .channel_open_direct_tcpip(host, port, originator, originator_port)
            .await
            .map_err(|e| AppError::Ssh(format!("direct-tcpip channel: {e}")))
    }

    /// Execute a single command on the remote host via a new exec channel
    /// and return its stdout. The PTY channel is unaffected.
    pub async fn exec(&self, command: &str) -> Result<String, AppError> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("exec channel_open: {e}")))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

        let mut stdout = Vec::with_capacity(4096);
        loop {
            match tokio::time::timeout(Duration::from_secs(5), channel.wait()).await {
                Ok(Some(msg)) => match msg {
                    russh::ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                    russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                    _ => {}
                },
                Ok(None) => break,
                Err(_) => break, // timeout — return what we have
            }
        }
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    }
}

/// Thread-safe map of all active SSH sessions, keyed by `runtime_id`.
pub type SessionMap = Arc<RwLock<HashMap<String, Arc<SshSession>>>>;

pub fn new_session_map() -> SessionMap {
    Arc::new(RwLock::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Open — the big handshake
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub async fn open(
    known_hosts: Arc<KnownHostsStore>,
    passphrase_gate: PromptMap<String>,
    host_key_gate: PromptMap<bool>,
    credentials_gate: PromptMap<CredentialsResponse>,
    host: String,
    port: u16,
    username: String,
    credential: Credential,
    cols: u32,
    rows: u32,
    on_output: Channel<PtyChunk>,
    on_status: Channel<SshStatus>,
) -> Result<OpenOutcome, AppError> {
    let runtime_id = uuid::Uuid::new_v4().to_string();
    let report = Arc::new(parking_lot::Mutex::new(None));

    let handler = ProsshHandler {
        host: host.clone(),
        port,
        known_hosts,
        report: report.clone(),
        host_key_gate: Some(host_key_gate),
        status_channel: Some(on_status.clone()),
    };

    let config = Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 5,
        ..Default::default()
    });

    // --- TCP connect (with a short timeout) -----------------------------------
    let addr: std::net::SocketAddr = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| AppError::Ssh(format!("DNS lookup for {host}: {e}")))?
        .next()
        .ok_or_else(|| AppError::Ssh(format!("could not resolve {host}:{port}")))?;

    let tcp = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    .map_err(|_| AppError::Ssh(format!("TCP connect to {host}:{port} timed out after 15s")))?
    .map_err(|e| AppError::Ssh(format!("TCP connect to {host}:{port}: {e}")))?;

    tcp.set_nodelay(true).ok();

    // --- SSH handshake (may include a user-facing host key prompt) ----------
    // No timeout here — the user might need time to verify the host key.
    let mut handle =
        russh::client::connect_stream(config, tcp, handler)
            .await
            .map_err(|e| {
                if let Some(r) = report.lock().clone() {
                    if let super::HostKeyStatus::Mismatch { stored } = &r.status {
                        return AppError::Ssh(format!(
                            "host key mismatch for {host}:{port} — server presents {fp}, we trusted {stored}. \
                             Revoke the old entry in Settings → Known hosts.",
                            fp = r.fingerprint,
                        ));
                    }
                }
                AppError::Ssh(format!("SSH handshake: {e}"))
            })?;

    // --- Authentication (with a 20-second timeout) ---------------------------
    // The timeout does NOT cover user prompt wait — only the server round-trip.
    let _ = on_status.send(SshStatus::Authenticating);

    let mut prompted_password: Option<String> = None;
    let mut prompted_username: Option<String> = None;
    let mut key_auth_fallback = false;

    // Helper: prompt user for credentials via the gate.
    async fn prompt_credentials(
        gate: &PromptMap<CredentialsResponse>,
        status_ch: &Channel<SshStatus>,
        current_username: &str,
        reason: &str,
    ) -> Result<CredentialsResponse, AppError> {
        let (prompt_id, rx) = crate::ssh::gate::register(gate).await;
        let _ = status_ch.send(SshStatus::CredentialsNeeded {
            prompt_id,
            username: current_username.to_string(),
            reason: reason.to_string(),
        });
        let resp = rx
            .await
            .map_err(|_| AppError::Ssh("credentials prompt cancelled".into()))?;
        if resp.password.is_empty() && resp.username.is_empty() {
            return Err(AppError::Ssh("credentials prompt cancelled by user".into()));
        }
        Ok(resp)
    }

    // Helper: try password auth on the handle.
    async fn try_password_auth(
        handle: &mut russh::client::Handle<ProsshHandler>,
        user: &str,
        pass: &str,
    ) -> Result<bool, AppError> {
        let auth = tokio::time::timeout(
            Duration::from_secs(20),
            handle.authenticate_password(user, pass),
        )
        .await
        .map_err(|_| AppError::Ssh("password auth timed out after 20s".into()))?
        .map_err(|e| AppError::Ssh(format!("auth: {e}")))?;
        Ok(auth.success())
    }

    // --- If username is empty, prompt immediately ---
    let mut effective_username = username.clone();
    if effective_username.is_empty() {
        let resp = prompt_credentials(
            &credentials_gate,
            &on_status,
            "",
            "no_username",
        )
        .await?;
        effective_username = resp.username.clone();
        prompted_username = Some(resp.username.clone());
        prompted_password = Some(resp.password.clone());

        // We already have a password — use password auth regardless of method.
        if !try_password_auth(&mut handle, &resp.username, &resp.password).await? {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "auth failed", "en")
                .await;
            return Err(AppError::Ssh("authentication failed".into()));
        }
        key_auth_fallback = matches!(credential, Credential::Key { .. });
    } else {
        // Username present — proceed with the configured method.
        match credential {
            Credential::Password(password) => {
                let (use_user, use_pass) = if let Some(pw) = password.filter(|p| !p.is_empty()) {
                    (effective_username.clone(), pw)
                } else {
                    // No password stored — prompt the user.
                    let resp = prompt_credentials(
                        &credentials_gate,
                        &on_status,
                        &effective_username,
                        "no_password",
                    )
                    .await?;
                    prompted_password = Some(resp.password.clone());
                    if resp.username != effective_username {
                        prompted_username = Some(resp.username.clone());
                        effective_username = resp.username.clone();
                    }
                    (resp.username, resp.password)
                };
                if !try_password_auth(&mut handle, &use_user, &use_pass).await? {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "auth failed", "en")
                        .await;
                    return Err(AppError::Ssh("authentication failed".into()));
                }
                // If password was prompted and auth worked, mark it for saving.
                if prompted_password.is_none() {
                    // Password was pre-stored and worked — nothing extra to save.
                }
            }
            Credential::Key { path, passphrase } => {
                use crate::ssh::auth::{load_private_key, KeyLoadResult};

                let key_path = path.clone();
                let mut pp = passphrase;

                // Loop: try loading → prompt if encrypted → retry once
                let loaded_key = loop {
                    let p = key_path.clone();
                    let pass = pp.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        load_private_key(&p, pass.as_deref())
                    })
                    .await
                    .map_err(|e| AppError::Internal(format!("join: {e}")))?;

                    match result? {
                        KeyLoadResult::Loaded(k) => break k,
                        KeyLoadResult::NeedsPassphrase => {
                            let (prompt_id, rx) =
                                crate::ssh::gate::register(&passphrase_gate).await;
                            let _ = on_status.send(SshStatus::PassphraseNeeded {
                                prompt_id: prompt_id.clone(),
                                key_path: path.display().to_string(),
                            });
                            let entered = rx.await.map_err(|_| {
                                AppError::Ssh("passphrase prompt cancelled".into())
                            })?;
                            if entered.is_empty() {
                                let _ = handle
                                    .disconnect(
                                        russh::Disconnect::ByApplication,
                                        "cancelled",
                                        "en",
                                    )
                                    .await;
                                return Err(AppError::Ssh(
                                    "passphrase prompt cancelled by user".into(),
                                ));
                            }
                            pp = Some(entered);
                        }
                    }
                };

                let ok = tokio::time::timeout(
                    Duration::from_secs(20),
                    crate::ssh::auth::authenticate_publickey(
                        &mut handle,
                        &effective_username,
                        loaded_key,
                    ),
                )
                .await
                .map_err(|_| AppError::Ssh("public key auth timed out after 20s".into()))?
                .map_err(|e| AppError::Ssh(format!("public key auth: {e}")))?;

                if !ok {
                    // Key rejected — fallback: prompt for password.
                    let resp = prompt_credentials(
                        &credentials_gate,
                        &on_status,
                        &effective_username,
                        "key_rejected",
                    )
                    .await?;
                    if resp.username != effective_username {
                        prompted_username = Some(resp.username.clone());
                        effective_username = resp.username.clone();
                    }
                    if !try_password_auth(&mut handle, &resp.username, &resp.password).await? {
                        let _ = handle
                            .disconnect(russh::Disconnect::ByApplication, "auth failed", "en")
                            .await;
                        return Err(AppError::Ssh("authentication failed".into()));
                    }
                    prompted_password = Some(resp.password);
                    key_auth_fallback = true;
                }
            }
        }
    }

    // --- PTY channel --------------------------------------------------------
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("channel: {e}")))?;

    channel
        .request_pty(
            false,
            "xterm-256color",
            cols,
            rows,
            0,
            0,
            &[], // no special modes
        )
        .await
        .map_err(|e| AppError::Ssh(format!("request_pty: {e}")))?;

    channel
        .request_shell(false)
        .await
        .map_err(|e| AppError::Ssh(format!("request_shell: {e}")))?;

    // --- Bidirectional PTY loop --------------------------------------------
    let (writer_tx, writer_rx) = mpsc::unbounded_channel::<PtyIn>();
    let rid = runtime_id.clone();
    let session_host = host.clone();

    // Send Connected status *before* spawning the reader task, so the
    // frontend knows the runtime_id is valid immediately.
    let _ = on_status.send(SshStatus::Connected {
        runtime_id: runtime_id.clone(),
    });

    let reader_task = tokio::spawn(async move {
        pty_loop(channel, writer_rx, on_output, &rid).await;
        let _ = on_status.send(SshStatus::Disconnected {
            runtime_id: rid.clone(),
            reason: "session ended".into(),
        });
        tracing::info!(runtime_id = %rid, host = %session_host, "pty loop exited");
    });

    let session = Arc::new(SshSession {
        runtime_id: runtime_id.clone(),
        session_id: String::new(), // filled by caller
        writer_tx,
        reader_task,
        handle,
    });

    tracing::info!(
        runtime_id = %runtime_id, host = %host, port, username = %effective_username,
        cols, rows, "pty session opened"
    );

    Ok(OpenOutcome {
        session,
        prompted_password,
        prompted_username,
        key_auth_fallback,
    })
}

/// The core select! loop that bridges the PTY channel with the frontend.
async fn pty_loop(
    mut channel: russh::Channel<russh::client::Msg>,
    mut writer_rx: mpsc::UnboundedReceiver<PtyIn>,
    on_output: Channel<PtyChunk>,
    runtime_id: &str,
) {
    loop {
        tokio::select! {
            msg = writer_rx.recv() => match msg {
                Some(PtyIn::Data(bytes)) => {
                    if let Err(e) = channel.data(&bytes[..]).await {
                        tracing::warn!(runtime_id, error = %e, "pty write error");
                        break;
                    }
                }
                Some(PtyIn::Resize { cols, rows }) => {
                    if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                        tracing::warn!(runtime_id, error = %e, "pty resize error");
                        // non-fatal, keep going
                    }
                }
                Some(PtyIn::Close) | None => break,
            },
            frame = channel.wait() => match frame {
                Some(russh::ChannelMsg::Data { ref data }) => {
                    let _ = on_output.send(PtyChunk { data: data.to_vec() });
                }
                Some(russh::ChannelMsg::ExtendedData { ref data, .. }) => {
                    // stderr from the remote shell — route to the same output
                    let _ = on_output.send(PtyChunk { data: data.to_vec() });
                }
                Some(russh::ChannelMsg::ExitStatus { .. })
                | Some(russh::ChannelMsg::Eof)
                | Some(russh::ChannelMsg::Close) => break,
                Some(_) => {} // window_adjusted etc.
                None => break,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Teardown helpers
// ---------------------------------------------------------------------------

/// Gracefully shut down a session: signal the PTY loop → SSH disconnect →
/// await the reader task (with a timeout).
pub async fn close(session: &SshSession) {
    let _ = session.writer_tx.send(PtyIn::Close);
    let _ = session
        .handle
        .disconnect(russh::Disconnect::ByApplication, "user closed", "en")
        .await;
    // Give the reader task a moment to finish before abandoning it.
    let task_ref = &session.reader_task;
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        // We can't await a &JoinHandle, but we can poll it with a sleep loop.
        while !task_ref.is_finished() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    if !session.reader_task.is_finished() {
        session.reader_task.abort();
    }
}

/// Tear down **all** sessions (called on app quit / WindowCloseRequested).
pub async fn close_all(map: &SessionMap) {
    let sessions: Vec<(String, Arc<SshSession>)> = {
        let mut guard = map.write().await;
        guard.drain().collect()
    };
    for (runtime_id, sess) in &sessions {
        super::forward::stop_forwards(runtime_id).await;
        close(sess).await;
    }
}
