//! Tauri IPC commands for user scripts (global + per-session).

use tauri::State;

use crate::error::AppError;
use crate::sessions::scripts::{self, Script, ScriptInput};
use crate::state::AppState;

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Internal(format!("blocking join failed: {e}"))
}

/// List scripts visible for a given session (global + session-specific).
/// If `session_id` is None, returns only global scripts.
#[tauri::command]
pub async fn scripts_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<Script>, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        scripts::list(&conn, session_id.as_deref())
    })
    .await
    .map_err(join_err)?
}

/// List only global scripts.
#[tauri::command]
pub async fn scripts_list_global(
    state: State<'_, AppState>,
) -> Result<Vec<Script>, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        scripts::list_global(&conn)
    })
    .await
    .map_err(join_err)?
}

/// List scripts for a specific session only (no globals).
#[tauri::command]
pub async fn scripts_list_for_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Script>, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        scripts::list_for_session(&conn, &session_id)
    })
    .await
    .map_err(join_err)?
}

/// Create or update a script.
#[tauri::command]
pub async fn scripts_upsert(
    state: State<'_, AppState>,
    input: ScriptInput,
) -> Result<Script, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        scripts::upsert(&conn, input)
    })
    .await
    .map_err(join_err)?
}

/// Delete a script by id.
#[tauri::command]
pub async fn scripts_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        scripts::delete(&conn, &id)
    })
    .await
    .map_err(join_err)?
}
