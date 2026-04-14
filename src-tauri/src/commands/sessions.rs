//! Tauri IPC commands for sessions & groups CRUD.
//!
//! Every call copies the `Arc<Mutex<Connection>>` out of `AppState` and then
//! runs the actual query on a blocking thread via [`tokio::task::spawn_blocking`].

use tauri::State;

use crate::error::AppError;
use crate::secrets;
use crate::sessions::{repo, secret_key, Group, GroupInput, PortForward, PortForwardInput, Session, SessionInput};
use crate::ssh::config as ssh_config;
use crate::ssh::import_moba;
use crate::ssh::import_putty;
use crate::state::AppState;

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Internal(format!("blocking join failed: {e}"))
}

// ----- sessions -----

#[tauri::command]
pub async fn sessions_list(state: State<'_, AppState>) -> Result<Vec<Session>, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::list_sessions(&conn)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn sessions_upsert(
    state: State<'_, AppState>,
    input: SessionInput,
) -> Result<Session, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::upsert_session(&conn, input)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn sessions_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let conn = state.db.conn.clone();
    let id_for_db = id.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::delete_session(&conn, &id_for_db)
    })
    .await
    .map_err(join_err)??;

    // Best-effort cleanup of the keychain entry. `secrets::clear` already
    // treats "no entry" as success, so re-deleting a session that never had a
    // stored secret is a no-op. We don't fail the delete if this errors — the
    // DB row is already gone.
    let key = secret_key(&id);
    if let Err(e) = tokio::task::spawn_blocking(move || secrets::clear(&key))
        .await
        .map_err(join_err)?
    {
        tracing::warn!(session = %id, error = %e, "failed to clear keychain entry after session delete");
    }

    Ok(())
}

/// Remove duplicate sessions, keeping one per unique host+port+username.
#[tauri::command]
pub async fn sessions_dedup(state: State<'_, AppState>) -> Result<u64, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::dedup_sessions(&conn)
    })
    .await
    .map_err(join_err)?
}

// ----- ssh config import -----

/// Discover Host entries from `~/.ssh/config` (or a user-provided path).
/// Returns the raw entries — the frontend decides which ones to actually import.
#[tauri::command]
pub async fn import_ssh_config(
    path: Option<String>,
) -> Result<Vec<ssh_config::SshConfigEntry>, AppError> {
    let config_path = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => ssh_config::default_config_path().ok_or_else(|| {
            AppError::NotFound("could not determine home directory for ~/.ssh/config".into())
        })?,
    };
    tokio::task::spawn_blocking(move || ssh_config::parse(&config_path))
        .await
        .map_err(join_err)?
}

/// Discover PuTTY sessions from the Windows Registry.
#[tauri::command]
pub async fn import_putty_sessions(
) -> Result<Vec<import_putty::PuttySession>, AppError> {
    tokio::task::spawn_blocking(import_putty::read_putty_sessions)
        .await
        .map_err(join_err)?
}

/// Discover MobaXTerm SSH sessions from the Windows Registry.
#[tauri::command]
pub async fn import_moba_sessions(
) -> Result<Vec<import_moba::MobaSession>, AppError> {
    tokio::task::spawn_blocking(import_moba::read_moba_sessions)
        .await
        .map_err(join_err)?
}

/// Import MobaXTerm SSH sessions from a `.mxtsessions` export file.
#[tauri::command]
pub async fn import_moba_file(
    path: String,
) -> Result<Vec<import_moba::MobaSession>, AppError> {
    tokio::task::spawn_blocking(move || import_moba::parse_mxtsessions_file(&path))
        .await
        .map_err(join_err)?
}

// ----- groups -----

#[tauri::command]
pub async fn groups_list(state: State<'_, AppState>) -> Result<Vec<Group>, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::list_groups(&conn)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn groups_upsert(
    state: State<'_, AppState>,
    input: GroupInput,
) -> Result<Group, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::upsert_group(&conn, input)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn groups_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::delete_group(&conn, &id)
    })
    .await
    .map_err(join_err)?
}

// ----- port forwards -----

#[tauri::command]
pub async fn port_forwards_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<PortForward>, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::list_port_forwards(&conn, &session_id)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn port_forwards_upsert(
    state: State<'_, AppState>,
    input: PortForwardInput,
) -> Result<PortForward, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::upsert_port_forward(&conn, input)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn port_forwards_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::delete_port_forward(&conn, &id)
    })
    .await
    .map_err(join_err)?
}
