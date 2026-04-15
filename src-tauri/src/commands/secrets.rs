//! Tauri IPC commands for managing session secrets and the master-password
//! vault.
//!
//! Per-session secrets (`secrets_set` / `_has` / `_clear` / `_copy`) use
//! whichever backend is currently active — see [`crate::secrets`] for the
//! dispatcher. There is deliberately no `secrets_get` so raw credentials
//! never round-trip through the frontend.
//!
//! The `vault_*` commands manage the encrypted file backend specifically:
//! create/unlock/lock/change-password. They are no-ops when the active
//! backend is the OS keyring.

use tauri::State;

use crate::error::AppError;
use crate::secrets::{self, BackendKind, BackendStatus};
use crate::sessions::secret_key;
use crate::state::AppState;

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

// ---- backend / vault management ----

const SETTINGS_KEY_BACKEND: &str = "secrets.backend";

/// Report which backend is in use and whether the file vault is
/// unlocked / exists.
#[tauri::command]
pub async fn secrets_backend_status() -> Result<BackendStatus, AppError> {
    tokio::task::spawn_blocking(secrets::status)
        .await
        .map_err(join_err)
}

/// Change the preferred backend. Persists to the settings table and
/// reconfigures the manager immediately. If the user picks `File` but the
/// vault isn't unlocked, subsequent `secrets_set` calls will fail until
/// they call `secrets_vault_unlock` / `secrets_vault_create`.
#[tauri::command]
pub async fn secrets_set_backend(
    state: State<'_, AppState>,
    kind: String,
) -> Result<BackendStatus, AppError> {
    let backend = BackendKind::from_str(&kind)
        .ok_or_else(|| AppError::InvalidArgument(format!("unknown backend: {kind}")))?;
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || -> Result<BackendStatus, AppError> {
        {
            let conn = conn.lock();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![SETTINGS_KEY_BACKEND, backend.as_str()],
            )
            .map_err(|e| AppError::Database(format!("persist backend: {e}")))?;
        }
        secrets::set_backend(backend);
        Ok(secrets::status())
    })
    .await
    .map_err(join_err)?
}

/// Create a brand-new encrypted vault with the supplied master password.
/// Fails if a vault already exists — the user should unlock it instead.
#[tauri::command]
pub async fn secrets_vault_create(password: String) -> Result<BackendStatus, AppError> {
    tokio::task::spawn_blocking(move || -> Result<BackendStatus, AppError> {
        // Guard: refuse to overwrite an existing vault — the user almost
        // certainly meant to unlock rather than wipe it.
        if secrets::status().file_exists {
            return Err(AppError::Secret(
                "encrypted vault already exists — unlock it instead of creating a new one".into(),
            ));
        }
        secrets::vault_create(&password)?;
        Ok(secrets::status())
    })
    .await
    .map_err(join_err)?
}

/// Attempt to decrypt the vault with the given master password.
#[tauri::command]
pub async fn secrets_vault_unlock(password: String) -> Result<BackendStatus, AppError> {
    tokio::task::spawn_blocking(move || -> Result<BackendStatus, AppError> {
        secrets::vault_unlock(&password)?;
        Ok(secrets::status())
    })
    .await
    .map_err(join_err)?
}

/// Drop the in-memory decryption key. The vault stays on disk; the user
/// has to unlock it again before any subsequent `secrets_get` will return
/// a value.
#[tauri::command]
pub async fn secrets_vault_lock() -> Result<BackendStatus, AppError> {
    tokio::task::spawn_blocking(|| {
        secrets::vault_lock();
        secrets::status()
    })
    .await
    .map_err(join_err)
}

/// Re-encrypt the vault under a new master password. Requires knowledge of
/// the current password even when already unlocked.
#[tauri::command]
pub async fn secrets_vault_change_password(
    old_password: String,
    new_password: String,
) -> Result<BackendStatus, AppError> {
    tokio::task::spawn_blocking(move || -> Result<BackendStatus, AppError> {
        secrets::vault_change_password(&old_password, &new_password)?;
        Ok(secrets::status())
    })
    .await
    .map_err(join_err)?
}

/// Remove the vault file entirely. Loses every stored secret — UI confirms
/// before calling.
#[tauri::command]
pub async fn secrets_vault_destroy() -> Result<BackendStatus, AppError> {
    tokio::task::spawn_blocking(|| -> Result<BackendStatus, AppError> {
        secrets::vault_destroy()?;
        Ok(secrets::status())
    })
    .await
    .map_err(join_err)?
}
