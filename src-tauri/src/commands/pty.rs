//! Tauri IPC commands for the PTY lifecycle.
//!
//! `open_session` is the big one — it performs the full SSH handshake, opens a
//! PTY channel with `request_pty + request_shell`, spawns the bidirectional
//! read/write loop, stores the session in the `ssh_sessions` map and returns
//! a `runtime_id` that the frontend uses for all subsequent calls.
//!
//! `write_to_pty`, `resize_pty`, `close_session` are thin dispatchers that
//! look up the session by `runtime_id` in the map and fire a message into the
//! writer mpsc channel.

use tauri::ipc::Channel;
use tauri::State;

use crate::error::AppError;
use crate::secrets;
use crate::sessions::{repo, secret_key, AuthMethod};
use crate::ssh::forward;
use crate::ssh::pty::{self, Credential, PtyChunk, PtyIn, SshStatus};
use crate::state::AppState;
use crate::ssh::gate;
use crate::commands::system;

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Internal(format!("blocking join failed: {e}"))
}

/// Open a new PTY session. Returns the `runtime_id` which uniquely identifies
/// the running terminal until `close_session` is called.
#[tauri::command]
pub async fn open_session(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
    on_output: Channel<PtyChunk>,
    on_status: Channel<SshStatus>,
) -> Result<String, AppError> {
    // 1. Load session from DB
    let conn = state.db.conn.clone();
    let sid = session_id.clone();
    let session = tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::fetch_session(&conn, &sid)
    })
    .await
    .map_err(join_err)??;

    // 2. Build credential based on auth method
    let credential = match session.auth_method {
        AuthMethod::Password => {
            let key = secret_key(&session.id);
            let password = tokio::task::spawn_blocking(move || secrets::get(&key))
                .await
                .map_err(join_err)??;
            // None → will be prompted by the gate inside open()
            Credential::Password(password)
        }
        AuthMethod::Key => {
            let key_path = session
                .private_key_path
                .as_deref()
                .ok_or_else(|| {
                    AppError::Ssh("no private key path configured for this session".into())
                })?
                .into();
            let secret_k = secret_key(&session.id);
            let passphrase = tokio::task::spawn_blocking(move || secrets::get(&secret_k))
                .await
                .map_err(join_err)??;
            Credential::Key {
                path: key_path,
                passphrase,
            }
        }
        AuthMethod::Agent => {
            return Err(AppError::Ssh(
                "SSH agent auth is not yet supported for terminal sessions".into(),
            ));
        }
    };

    // 3. Open SSH + PTY
    let outcome = pty::open(
        state.known_hosts.clone(),
        state.passphrase_gate.clone(),
        state.host_key_gate.clone(),
        state.credentials_gate.clone(),
        session.host.clone(),
        session.port,
        session.username.clone(),
        credential,
        cols,
        rows,
        on_output,
        on_status,
    )
    .await?;

    let ssh = outcome.session.clone();
    let runtime_id = ssh.runtime_id.clone();

    // 4. Save prompted credentials if the user entered them during auth.
    if outcome.prompted_password.is_some()
        || outcome.prompted_username.is_some()
        || outcome.key_auth_fallback
    {
        // Save password to keychain
        if let Some(ref password) = outcome.prompted_password {
            let sk = secret_key(&session.id);
            let pw = password.clone();
            let _ = tokio::task::spawn_blocking(move || secrets::set(&sk, &pw))
                .await
                .map_err(join_err)?;
        }
        // Update session in DB (auth method / username)
        let new_auth = if outcome.key_auth_fallback {
            Some(AuthMethod::Password)
        } else {
            None
        };
        let new_user = outcome.prompted_username.clone();
        if new_auth.is_some() || new_user.is_some() {
            let conn = state.db.conn.clone();
            let sid = session.id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let conn = conn.lock();
                repo::patch_session_auth(&conn, &sid, new_auth, new_user.as_deref())
            })
            .await
            .map_err(join_err)?;
        }
    }

    // 5. Store in map
    {
        let mut map = state.ssh_sessions.write().await;
        map.insert(runtime_id.clone(), ssh.clone());
    }

    // 5b. Start port forwards
    {
        let conn = state.db.conn.clone();
        let sid = session_id.clone();
        let forwards = tokio::task::spawn_blocking(move || {
            let conn = conn.lock();
            repo::list_port_forwards(&conn, &sid)
        })
        .await
        .map_err(join_err)??;

        if !forwards.is_empty() {
            forward::start_forwards(&runtime_id, ssh.clone(), &forwards).await;
        }
    }

    // 6. Touch last_used_at
    let conn = state.db.conn.clone();
    let touch_id = session.id.clone();
    if let Err(e) = tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::touch_session(&conn, &touch_id)
    })
    .await
    .map_err(join_err)?
    {
        tracing::warn!(session = %session.id, error = %e, "failed to touch session");
    }

    Ok(runtime_id)
}

/// Send keystrokes (or any raw bytes) to the remote shell.
#[tauri::command]
pub async fn write_to_pty(
    state: State<'_, AppState>,
    runtime_id: String,
    data: Vec<u8>,
) -> Result<(), AppError> {
    let session = {
        let map = state.ssh_sessions.read().await;
        map.get(&runtime_id).cloned()
    };
    let session =
        session.ok_or_else(|| AppError::NotFound(format!("pty session {runtime_id}")))?;
    session
        .writer_tx
        .send(PtyIn::Data(data))
        .map_err(|_| AppError::Ssh("pty channel closed".into()))
}

/// Notify the remote shell of a terminal resize.
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, AppState>,
    runtime_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    let session = {
        let map = state.ssh_sessions.read().await;
        map.get(&runtime_id).cloned()
    };
    let session =
        session.ok_or_else(|| AppError::NotFound(format!("pty session {runtime_id}")))?;
    session
        .writer_tx
        .send(PtyIn::Resize { cols, rows })
        .map_err(|_| AppError::Ssh("pty channel closed".into()))
}

/// Gracefully tear down a terminal session.
#[tauri::command]
pub async fn close_session(
    state: State<'_, AppState>,
    runtime_id: String,
) -> Result<(), AppError> {
    let session = {
        let mut map = state.ssh_sessions.write().await;
        map.remove(&runtime_id)
    };
    if let Some(session) = session {
        forward::stop_forwards(&runtime_id).await;
        pty::close(&session).await;
        system::clear_stats_cache(&runtime_id).await;
        tracing::info!(runtime_id = %runtime_id, "pty session closed by user");
    }
    Ok(())
}

/// Resolve a pending passphrase prompt. Called from the frontend's
/// `PassphrasePromptDialog`. An empty string means the user cancelled.
#[tauri::command]
pub async fn resolve_passphrase(
    state: State<'_, AppState>,
    prompt_id: String,
    passphrase: String,
) -> Result<(), AppError> {
    gate::resolve(&state.passphrase_gate, &prompt_id, passphrase).await;
    Ok(())
}

/// Resolve a pending host-key prompt (step 9). `accept = true` means the
/// user confirmed the fingerprint; `false` means they rejected it.
#[tauri::command]
pub async fn resolve_host_key(
    state: State<'_, AppState>,
    prompt_id: String,
    accept: bool,
) -> Result<(), AppError> {
    // Debug logging
    if let Some(desktop) = dirs::desktop_dir() {
        let _ = std::fs::OpenOptions::new()
            .create(true).append(true)
            .open(desktop.join("prossh-debug.log"))
            .and_then(|mut f| {
                use std::io::Write;
                let map_len = state.host_key_gate.try_read().map(|m| m.len()).unwrap_or(999);
                writeln!(f, "[{}] resolve_host_key: prompt_id={prompt_id}, accept={accept}, gate_map_len={map_len}",
                    chrono::Local::now().format("%H:%M:%S%.3f"))
            });
    }
    let resolved = gate::resolve(&state.host_key_gate, &prompt_id, accept).await;
    if let Some(desktop) = dirs::desktop_dir() {
        let _ = std::fs::OpenOptions::new()
            .create(true).append(true)
            .open(desktop.join("prossh-debug.log"))
            .and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "[{}] resolve_host_key: resolved={resolved}",
                    chrono::Local::now().format("%H:%M:%S%.3f"))
            });
    }
    Ok(())
}
