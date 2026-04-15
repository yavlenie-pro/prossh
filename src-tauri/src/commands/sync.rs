//! Tauri IPC commands for Google Drive cloud sync.
//!
//! The heavy lifting lives in [`crate::sync`] — this file is just an async
//! wrapper that (a) owns the `State<AppState>` borrow, (b) clones the DB
//! connection handle out of it, and (c) bridges the browser-open callback
//! to `tauri-plugin-shell`.

use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::state::AppState;
use crate::sync::{self, ApplyStats, SyncConfig, SyncStatus};

/// Return the current sync config + connection state.
#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus, AppError> {
    let conn = state.db.conn.clone();
    let runtime = state.sync_runtime.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        sync::load_status(&conn, &runtime)
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}

/// Current sync config (subset of status without the per-invocation state).
#[tauri::command]
pub async fn sync_config_get(state: State<'_, AppState>) -> Result<SyncConfig, AppError> {
    let conn = state.db.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        sync::load_config(&conn)
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}

/// Persist the sync config. Pass `clientSecret=null` to leave the existing
/// one alone; empty string clears it.
#[tauri::command]
pub async fn sync_config_set(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: Option<String>,
    filename: String,
    enabled: bool,
) -> Result<SyncStatus, AppError> {
    let conn = state.db.conn.clone();
    let runtime = state.sync_runtime.clone();
    tokio::task::spawn_blocking(move || -> Result<SyncStatus, AppError> {
        let conn = conn.lock();
        sync::save_config(
            &conn,
            &client_id,
            client_secret.as_deref(),
            &filename,
            enabled,
        )?;
        sync::load_status(&conn, &runtime)
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}

/// Kick off the OAuth loopback flow. Opens the system browser to Google's
/// consent page, waits for the redirect back to `127.0.0.1:<port>`, and
/// persists the resulting tokens.
///
/// This is a *long-running* command — it blocks for however long the user
/// takes to click through the consent screen (capped at 5 minutes by the
/// oauth module). The frontend should show a "waiting for browser" state.
#[tauri::command]
pub async fn sync_oauth_connect(
    state: State<'_, AppState>,
) -> Result<SyncStatus, AppError> {
    let conn = state.db.conn.clone();
    let runtime = state.sync_runtime.clone();
    sync::connect(conn, runtime, |url| {
        open::that(url).map_err(|e| AppError::Internal(format!("open browser: {e}")))
    })
    .await
}

/// Revoke + clear the OAuth tokens. Safe to call even when not connected.
/// Also stops the auto-sync task and wipes the cached passphrase.
#[tauri::command]
pub async fn sync_oauth_disconnect(
    state: State<'_, AppState>,
) -> Result<SyncStatus, AppError> {
    let conn = state.db.conn.clone();
    let runtime = state.sync_runtime.clone();
    sync::disconnect(conn, runtime).await
}

/// Encrypt the local snapshot with the supplied passphrase and push to Drive.
#[tauri::command]
pub async fn sync_push(
    state: State<'_, AppState>,
    passphrase: String,
) -> Result<SyncStatus, AppError> {
    let conn = state.db.conn.clone();
    let runtime = state.sync_runtime.clone();
    sync::push(conn, runtime, passphrase).await
}

/// Download, decrypt with `passphrase`, and merge into the local DB.
/// Returns the number of rows touched per table.
#[tauri::command]
pub async fn sync_pull(
    state: State<'_, AppState>,
    passphrase: String,
) -> Result<ApplyStats, AppError> {
    let conn = state.db.conn.clone();
    sync::pull(conn, passphrase).await
}

/// Encrypt the local snapshot with `passphrase` and write it to `path`.
/// Used by the "Export to file" flow — no cloud, no OAuth, the user picks
/// the destination via a save dialog on the frontend side.
#[tauri::command]
pub async fn sync_export_file(
    state: State<'_, AppState>,
    passphrase: String,
    path: String,
) -> Result<(), AppError> {
    let conn = state.db.conn.clone();
    sync::export_to_file(conn, passphrase, path).await
}

/// Read `path`, decrypt with `passphrase`, and merge into the local DB.
/// Counterpart to [`sync_export_file`].
#[tauri::command]
pub async fn sync_import_file(
    state: State<'_, AppState>,
    passphrase: String,
    path: String,
) -> Result<ApplyStats, AppError> {
    let conn = state.db.conn.clone();
    sync::import_from_file(conn, passphrase, path).await
}

// ---- auto-sync orchestration ----
//
// The frontend calls these to (a) cache the passphrase right after OAuth
// completes (so auto-sync can encrypt without re-prompting), and (b) tweak
// the loop cadence.

/// Cache `passphrase` in RAM and (re)start the auto-sync loop. When
/// `remember` is true, the passphrase is also persisted to the OS secret
/// backend so it survives a process restart — opt-in only, surfaced as a
/// checkbox in the setup dialog.
#[tauri::command]
pub async fn sync_passphrase_set(
    state: State<'_, AppState>,
    app: AppHandle,
    passphrase: String,
    remember: bool,
) -> Result<SyncStatus, AppError> {
    if passphrase.is_empty() {
        return Err(AppError::InvalidArgument(
            "sync passphrase must not be empty".into(),
        ));
    }

    state.sync_runtime.set_passphrase(passphrase.clone());

    if remember {
        sync::remember_passphrase(&passphrase)?;
    } else {
        // Drop any previously-stored copy so the user's "Forget" intent
        // actually takes effect.
        let _ = sync::forget_passphrase();
    }

    sync::start_auto_sync(state.db.conn.clone(), state.sync_runtime.clone(), app)?;

    let conn = state.db.conn.clone();
    let runtime = state.sync_runtime.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        sync::load_status(&conn, &runtime)
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}

/// Wipe both the in-memory and persisted passphrase. Auto-sync keeps
/// running but each tick will skip until a new passphrase is supplied.
#[tauri::command]
pub async fn sync_passphrase_clear(
    state: State<'_, AppState>,
) -> Result<SyncStatus, AppError> {
    state.sync_runtime.clear_passphrase();
    let _ = sync::forget_passphrase();

    let conn = state.db.conn.clone();
    let runtime = state.sync_runtime.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        sync::load_status(&conn, &runtime)
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}

/// Update the auto-sync cadence in minutes (`0` = off) and respawn the
/// background task with the new interval.
#[tauri::command]
pub async fn sync_auto_interval_set(
    state: State<'_, AppState>,
    app: AppHandle,
    minutes: u32,
) -> Result<SyncStatus, AppError> {
    let conn = state.db.conn.clone();
    let runtime = state.sync_runtime.clone();

    {
        let conn = conn.lock();
        sync::save_auto_interval(&conn, minutes)?;
    }

    sync::start_auto_sync(conn.clone(), runtime.clone(), app)?;

    tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        sync::load_status(&conn, &runtime)
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}

/// Trigger one auto-sync cycle right now, regardless of the timer. Used
/// by the "Sync now" button in the UI. Errors propagate to the caller so
/// the UI can show them (unlike the timer-driven loop which only emits
/// events).
#[tauri::command]
pub async fn sync_auto_run_now(
    state: State<'_, AppState>,
) -> Result<SyncStatus, AppError> {
    let pass = state
        .sync_runtime
        .passphrase()
        .ok_or_else(|| AppError::InvalidArgument("master passphrase isn't set".into()))?;

    let conn = state.db.conn.clone();
    let runtime = state.sync_runtime.clone();

    // Pull then push — same order as the timed loop. If pull fails for any
    // reason other than NotFound (wrong passphrase, network, decrypt, …) we
    // must NOT push: the remote file is real, we just couldn't read it, so
    // overwriting it with our local state would clobber data another device
    // uploaded. NotFound is the one case where the remote genuinely doesn't
    // exist yet and a push is appropriate (first device seeding the vault).
    match sync::pull(conn.clone(), pass.clone()).await {
        Ok(_) => {}
        Err(AppError::NotFound(_)) => {
            tracing::info!("manual sync: remote file missing — first push will create it");
        }
        Err(e) => {
            tracing::warn!(error = %e, "manual sync pull failed — aborting before push");
            return Err(e);
        }
    }
    sync::push(conn.clone(), runtime.clone(), pass).await?;

    let conn2 = conn.clone();
    let runtime2 = runtime.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn2.lock();
        sync::load_status(&conn, &runtime2)
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))?
}
