//! Tauri IPC commands for managing session secrets.
//!
//! Note: there's no `secrets_get` command by design — the frontend should
//! never see raw credentials after writing them. Retrieval happens on the
//! backend during SSH connect. Every call runs on a blocking thread since
//! the keyring crate issues synchronous OS IPC (dbus / wincred / Keychain).

use crate::error::AppError;
use crate::secrets;
use crate::sessions::secret_key;

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Internal(format!("blocking join failed: {e}"))
}

/// Store a password or passphrase for the given session id.
#[tauri::command]
pub async fn secrets_set(session_id: String, secret: String) -> Result<(), AppError> {
    let key = secret_key(&session_id);
    tokio::task::spawn_blocking(move || secrets::set(&key, &secret))
        .await
        .map_err(join_err)?
}

/// Report whether a secret is currently stored for the given session id.
#[tauri::command]
pub async fn secrets_has(session_id: String) -> Result<bool, AppError> {
    let key = secret_key(&session_id);
    tokio::task::spawn_blocking(move || secrets::has(&key))
        .await
        .map_err(join_err)?
}

/// Copy the stored secret from one session to another.
/// If the source session has no secret, nothing happens (no error).
#[tauri::command]
pub async fn secrets_copy(
    from_session_id: String,
    to_session_id: String,
) -> Result<(), AppError> {
    let from_key = secret_key(&from_session_id);
    let to_key = secret_key(&to_session_id);
    tokio::task::spawn_blocking(move || {
        if let Some(secret) = secrets::get(&from_key)? {
            secrets::set(&to_key, &secret)?;
        }
        Ok(())
    })
    .await
    .map_err(join_err)?
}

/// Remove the stored secret (no-op if none exists).
#[tauri::command]
pub async fn secrets_clear(session_id: String) -> Result<(), AppError> {
    let key = secret_key(&session_id);
    tokio::task::spawn_blocking(move || secrets::clear(&key))
        .await
        .map_err(join_err)?
}
