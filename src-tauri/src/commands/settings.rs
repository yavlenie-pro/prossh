//! Tauri IPC commands for settings and color profiles.

use rusqlite::OptionalExtension;
use tauri::State;

use crate::error::AppError;
use crate::sessions::color_profiles::{self, ColorProfile, ColorProfileInput};
use crate::state::AppState;

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Internal(format!("blocking join failed: {e}"))
}

// ----- color profiles -----

#[tauri::command]
pub async fn color_profiles_list(
    state: State<'_, AppState>,
) -> Result<Vec<ColorProfile>, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        color_profiles::list(&conn)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn color_profiles_upsert(
    state: State<'_, AppState>,
    input: ColorProfileInput,
) -> Result<ColorProfile, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        color_profiles::upsert(&conn, input)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn color_profiles_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        color_profiles::delete(&conn, &id)
    })
    .await
    .map_err(join_err)?
}

// ----- settings KV -----

#[tauri::command]
pub async fn settings_get(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| AppError::Database(format!("settings_get: {e}")))
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn settings_set(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|e| AppError::Database(format!("settings_set: {e}")))?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}
