//! Tauri IPC commands for the known-hosts store.
//!
//! The frontend only gets read and revoke access. Adding/updating entries
//! happens backend-side during SSH connect (step 5) and host-key prompt
//! (step 9).

use tauri::State;

use crate::error::AppError;
use crate::known_hosts::KnownHostEntry;
use crate::state::AppState;

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Internal(format!("blocking join failed: {e}"))
}

/// Return every trusted host key currently in the store.
#[tauri::command]
pub async fn known_hosts_list(
    state: State<'_, AppState>,
) -> Result<Vec<KnownHostEntry>, AppError> {
    let store = state.known_hosts.clone();
    tokio::task::spawn_blocking(move || Ok::<_, AppError>(store.list()))
        .await
        .map_err(join_err)?
}

/// Revoke a single `(host, port, algorithm)` entry. Returns whether anything
/// was removed.
#[tauri::command]
pub async fn known_hosts_remove(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    algorithm: String,
) -> Result<bool, AppError> {
    let store = state.known_hosts.clone();
    tokio::task::spawn_blocking(move || store.remove(&host, port, &algorithm))
        .await
        .map_err(join_err)?
}

/// Revoke every entry for a `(host, port)` pair, regardless of algorithm.
/// Returns the number of entries removed. Useful when a user wants a full
/// reset for a host whose keys have rotated.
#[tauri::command]
pub async fn known_hosts_clear_host(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> Result<u32, AppError> {
    let store = state.known_hosts.clone();
    let removed = tokio::task::spawn_blocking(move || store.clear_host(&host, port))
        .await
        .map_err(join_err)??;
    Ok(removed as u32)
}
