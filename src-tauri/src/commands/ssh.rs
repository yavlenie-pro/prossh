//! Tauri IPC commands for SSH lifecycle.
//!
//! Step 5 ships just one command: [`ssh_test_connect`] — a synchronous
//! connect + exec probe used by the "Test" button in the session edit dialog.
//! Steps 6+ add the persistent PTY commands (`open_session`, `write_to_pty`,
//! `resize_pty`, `close_session`) on top.

use tauri::State;

use crate::error::AppError;
use crate::secrets;
use crate::sessions::{repo, secret_key, AuthMethod};
use crate::ssh::{self, SshTestResult};
use crate::state::AppState;

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Internal(format!("blocking join failed: {e}"))
}

// ---------------------------------------------------------------------------
// OS detection
// ---------------------------------------------------------------------------

/// Derive an opaque OS-family token (lowercase, stable) from the combined
/// output of `uname -s` and `/etc/os-release`. Returns `None` if nothing
/// recognisable is found.
///
/// The token set is deliberately coarse — it's consumed by the frontend's
/// `OsIcon` component which maps these strings to a specific icon:
/// `linux | ubuntu | debian | centos | fedora | arch | alpine | freebsd |
/// macos | windows`.
fn parse_os(stdout: &str) -> Option<String> {
    let lower = stdout.to_lowercase();

    // macOS / BSD take precedence over generic `linux` because `uname -s`
    // reports distinct tokens there.
    if lower.contains("darwin") {
        return Some("macos".into());
    }
    if lower.contains("freebsd") || lower.contains("openbsd") || lower.contains("netbsd") {
        return Some("freebsd".into());
    }

    // When `cat /etc/os-release` succeeds, prefer its `ID=` field — that's
    // what distros use as their canonical short name.
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("ID=") {
            let id = rest.trim().trim_matches('"').to_lowercase();
            return Some(match id.as_str() {
                "ubuntu" => "ubuntu",
                "debian" | "raspbian" => "debian",
                "fedora" => "fedora",
                "centos" | "rhel" | "rocky" | "almalinux" | "ol" => "centos",
                "arch" | "manjaro" | "endeavouros" => "arch",
                "alpine" => "alpine",
                // Unknown distro ID but we still know it's Linux-based.
                _ => "linux",
            }.to_string());
        }
    }

    // Fallback — `uname -s` only (no /etc/os-release). Linux without distro
    // info is still useful for picking the penguin icon.
    if lower.contains("linux") {
        return Some("linux".into());
    }

    None
}

/// Detect the remote OS for an open PTY session and persist it on the
/// associated `Session` row. Returns the token that was stored (or
/// `None` if detection failed entirely — caller can fall back to heuristics).
///
/// The runtime does not need a new auth round — we piggyback on the existing
/// SSH transport via [`crate::ssh::pty::SshSession::exec`] and cap the whole
/// thing with a short timeout.
#[tauri::command]
pub async fn ssh_detect_os(
    state: State<'_, AppState>,
    runtime_id: String,
    session_id: String,
) -> Result<Option<String>, AppError> {
    // Look up the live SSH session. If the user already closed the tab by
    // the time we run, silently bail.
    let ssh = {
        let map = state.ssh_sessions.read().await;
        map.get(&runtime_id).cloned()
    };
    let Some(ssh) = ssh else {
        return Ok(None);
    };

    // 1) Unix path — `uname` + `/etc/os-release`. The `;` operator makes the
    // second command run even if the first fails, and stderr is discarded so
    // the output is easy to parse.
    let unix_probe = "uname -s 2>/dev/null; cat /etc/os-release 2>/dev/null";
    let unix_out = ssh.exec(unix_probe).await.unwrap_or_default();

    let mut token = parse_os(&unix_out);

    // 2) Windows fallback — OpenSSH for Windows launches cmd.exe, so `ver`
    // reports the Windows build. We only probe this if the Unix probe came
    // back empty or unrecognisable, to avoid a second round-trip on Linux.
    if token.is_none() {
        let win_out = ssh.exec("ver").await.unwrap_or_default();
        if win_out.to_lowercase().contains("windows") {
            token = Some("windows".into());
        }
    }

    // 3) Persist if we got something. Don't fail the call on DB errors —
    // detection is best-effort, the UI still works without it.
    if let Some(ref os) = token {
        let conn = state.db.conn.clone();
        let sid = session_id.clone();
        let os_for_db = os.clone();
        let write_res = tokio::task::spawn_blocking(move || {
            let conn = conn.lock();
            repo::patch_session_os(&conn, &sid, &os_for_db)
        })
        .await
        .map_err(join_err)?;
        if let Err(e) = write_res {
            tracing::warn!(session = %session_id, error = %e, "failed to persist os_type");
        } else {
            tracing::info!(session = %session_id, os = %os, "detected remote OS");
        }
    } else {
        tracing::debug!(session = %session_id, "remote OS detection inconclusive");
    }

    Ok(token)
}

/// Open a temporary SSH connection to a saved session, run a single command
/// (default `whoami`) and return the output. Host-key verification goes
/// through the [`crate::known_hosts::KnownHostsStore`] with TOFU semantics.
///
/// For MVP this only supports password auth — key/agent methods surface
/// a clear `AppError::Ssh("not yet supported ...")` error.
#[tauri::command]
pub async fn ssh_test_connect(
    state: State<'_, AppState>,
    session_id: String,
    command: Option<String>,
) -> Result<SshTestResult, AppError> {
    // 1. Load the session metadata from SQLite. spawn_blocking because
    //    rusqlite is synchronous.
    let conn = state.db.conn.clone();
    let session_id_for_db = session_id.clone();
    let session = tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::fetch_session(&conn, &session_id_for_db)
    })
    .await
    .map_err(join_err)??;

    // 2. For MVP only password auth is exercised end-to-end. Key auth lands
    //    in step 8, agent in a later step.
    match session.auth_method {
        AuthMethod::Password => {}
        AuthMethod::Key => {
            return Err(AppError::Ssh(
                "key-based auth is not yet supported by the Test button (step 8)".into(),
            ));
        }
        AuthMethod::Agent => {
            return Err(AppError::Ssh(
                "SSH agent auth is not yet supported by the Test button".into(),
            ));
        }
    }

    // 3. Fetch the stored password from the OS keychain.
    let key = secret_key(&session.id);
    let password = tokio::task::spawn_blocking(move || secrets::get(&key))
        .await
        .map_err(join_err)??
        .ok_or_else(|| {
            AppError::Ssh(
                "no password stored in keychain for this session — \
                 edit it and save a password before testing"
                    .into(),
            )
        })?;

    // 4. Run the probe. Default to a harmless single-line command so the UI
    //    can eyeball the result.
    let probe = command.unwrap_or_else(|| "whoami".to_string());
    let known_hosts = state.known_hosts.clone();
    let host = session.host.clone();
    let port = session.port;
    let username = session.username.clone();

    tracing::info!(
        session = %session.id, host = %host, port, username = %username,
        command = %probe, "ssh test connect"
    );

    let result = ssh::test_connect(known_hosts, host, port, username, password, probe).await?;

    // 5. Update last_used_at so the sidebar can sort by recency later on.
    let conn = state.db.conn.clone();
    let touch_id = session.id.clone();
    if let Err(e) = tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::touch_session(&conn, &touch_id)
    })
    .await
    .map_err(join_err)?
    {
        tracing::warn!(session = %session.id, error = %e, "failed to touch session after test connect");
    }

    Ok(result)
}
