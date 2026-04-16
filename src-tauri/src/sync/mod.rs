//! Google Drive cloud sync — connect an account, push a snapshot, pull it back.
//!
//! The module is layered so the integration points stay small:
//!
//! - [`crypto`]  — pure AES-256-GCM/Argon2 envelope (same as file vault
//!   but with a different magic, so snapshots and vaults can't be confused)
//! - [`oauth`]   — OAuth 2.0 "Installed App" loopback flow + token refresh
//! - [`drive`]   — minimal Drive v3 REST client (list/create/update/download)
//! - [`payload`] — collect/apply a `Snapshot` from the local DB + secrets
//! - this file  — glue: how config is stored, where tokens live, the
//!   `push` / `pull` / `connect` / `disconnect` flows that the command
//!   layer hands to the frontend
//!
//! ## Where things live
//!
//! | Datum                | Store                        | Key                        |
//! |----------------------|------------------------------|----------------------------|
//! | client_id            | settings KV                  | `sync.google.clientId`     |
//! | client_secret        | secrets backend              | `sync::google::secret`     |
//! | filename             | settings KV                  | `sync.google.filename`     |
//! | enabled flag         | settings KV                  | `sync.google.enabled`      |
//! | last known file_id   | settings KV                  | `sync.google.fileId`       |
//! | last pushed/pulled   | settings KV                  | `sync.google.lastSyncedAt` |
//! | OAuth tokens (JSON)  | secrets backend              | `sync::google::tokens`     |
//!
//! The client_secret and tokens go through the ordinary secret backend —
//! the same one that already holds SSH passwords — so if the user is using
//! the encrypted file vault, syncing shares the same unlock gate.

pub mod crypto;
pub mod drive;
pub mod oauth;
pub mod payload;
pub mod runtime;

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

pub use payload::ApplyStats;
pub use runtime::SyncRuntime;

// ---- storage keys ----

const KV_CLIENT_ID: &str = "sync.google.clientId";
const KV_FILENAME: &str = "sync.google.filename";
const KV_ENABLED: &str = "sync.google.enabled";
const KV_FILE_ID: &str = "sync.google.fileId";
const KV_LAST_SYNCED: &str = "sync.google.lastSyncedAt";
const KV_ACCOUNT_EMAIL: &str = "sync.google.accountEmail";
const KV_ACCOUNT_NAME: &str = "sync.google.accountName";
/// Auto-sync cadence in minutes. `0` (or absent) means auto-sync is off.
const KV_AUTO_INTERVAL_MIN: &str = "sync.google.autoIntervalMin";

const SECRET_CLIENT_SECRET: &str = "sync::google::clientSecret";
const SECRET_TOKENS: &str = "sync::google::tokens";
/// Optional persistence of the master passphrase so auto-sync survives a
/// process restart. Stored only when the user opts in via the setup dialog
/// ("Remember on this device"). Lives in the same secret backend as SSH
/// passwords — OS keyring or the encrypted vault.
const SECRET_CACHED_PASSPHRASE: &str = "sync::google::cachedPassphrase";

/// Auto-sync loop emits these events as it works. The frontend listens for
/// them to refresh `SyncStatus` and surface toast notifications.
pub const EVT_AUTO_PUSHED: &str = "sync-auto-pushed";
pub const EVT_AUTO_PULLED: &str = "sync-auto-pulled";
pub const EVT_AUTO_ERROR: &str = "sync-auto-error";
pub const EVT_AUTO_SKIPPED: &str = "sync-auto-skipped";

/// The default filename we create on Drive if the user hasn't picked one.
pub const DEFAULT_FILENAME: &str = "prossh-sessions.vault";

/// Default OAuth credentials baked in at build time, so the common user
/// doesn't have to touch Google Cloud Console. Set these via environment
/// variables before running `tauri build`:
///
/// ```sh
/// PROSSH_GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
/// PROSSH_GOOGLE_CLIENT_SECRET=GOCSPX-... \
///   npm run tauri build
/// ```
///
/// For a Desktop-app OAuth client Google itself says the client secret is
/// "not treated as a secret" — extracting it from a shipped binary gains
/// an attacker nothing they couldn't do by registering their own. The user
/// can still override with their own credentials in Advanced settings,
/// which matters if the embedded app ever hits its user quota or gets
/// banned upstream.
const EMBEDDED_CLIENT_ID: Option<&str> = option_env!("PROSSH_GOOGLE_CLIENT_ID");
const EMBEDDED_CLIENT_SECRET: Option<&str> = option_env!("PROSSH_GOOGLE_CLIENT_SECRET");

fn embedded_client_id() -> Option<&'static str> {
    EMBEDDED_CLIENT_ID.filter(|s| !s.is_empty())
}

fn embedded_client_secret() -> Option<&'static str> {
    EMBEDDED_CLIENT_SECRET.filter(|s| !s.is_empty())
}

fn has_embedded_creds() -> bool {
    embedded_client_id().is_some() && embedded_client_secret().is_some()
}

/// Resolve the OAuth client credentials the sync flow should use. User-set
/// values (Advanced settings) take precedence over the embedded defaults.
/// Returns an error with a user-facing hint when nothing is configured at
/// either layer.
fn resolve_creds(conn: &Connection) -> Result<(String, String), AppError> {
    let user_id = kv_get(conn, KV_CLIENT_ID)?.unwrap_or_default();
    let user_id = user_id.trim();
    if !user_id.is_empty() {
        let user_secret = crate::secrets::get(SECRET_CLIENT_SECRET)?.unwrap_or_default();
        if user_secret.is_empty() {
            return Err(AppError::InvalidArgument(
                "Custom OAuth client ID is set but the client secret is missing. \
                 Fill it in under Settings → Sync → Advanced, or clear the \
                 client ID to fall back to the built-in credentials."
                    .into(),
            ));
        }
        return Ok((user_id.to_string(), user_secret));
    }
    match (embedded_client_id(), embedded_client_secret()) {
        (Some(id), Some(secret)) => Ok((id.to_string(), secret.to_string())),
        _ => Err(AppError::InvalidArgument(
            "Google Drive isn't configured. Open Settings → Sync → Advanced \
             and paste a Client ID / Client secret from Google Cloud Console."
                .into(),
        )),
    }
}

// ---- config read / write helpers ----

fn kv_get(conn: &Connection, key: &str) -> Result<Option<String>, AppError> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| AppError::Database(format!("settings_get {key}: {e}")))
}

fn kv_set(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| AppError::Database(format!("settings_set {key}: {e}")))?;
    Ok(())
}

fn kv_delete(conn: &Connection, key: &str) -> Result<(), AppError> {
    conn.execute("DELETE FROM settings WHERE key = ?1", rusqlite::params![key])
        .map_err(|e| AppError::Database(format!("settings_delete {key}: {e}")))?;
    Ok(())
}

// ---- public DTOs ----

/// User-visible configuration. `clientSecret` and tokens deliberately
/// *don't* appear here — they're managed separately and never round-trip
/// through the frontend as plain text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub client_id: String,
    pub filename: String,
    pub enabled: bool,
    /// Whether we have a user-supplied client_secret stored. The frontend
    /// uses this to render a "(stored — type to replace)" hint next to the
    /// advanced input.
    #[serde(default)]
    pub has_client_secret: bool,
    /// Whether the build ships with default OAuth credentials. When true,
    /// the frontend hides the Advanced section by default — users can just
    /// click "Connect to Google Drive" without touching Cloud Console.
    #[serde(default)]
    pub has_embedded_creds: bool,
    /// Auto-sync cadence in minutes. `0` means disabled. The frontend
    /// renders this as a select; backend treats every non-zero value as
    /// "spawn a loop that ticks every N minutes".
    #[serde(default)]
    pub auto_sync_interval_min: u32,
}

/// Everything the frontend needs to render the Sync panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub config: SyncConfig,
    /// True when an OAuth token is stored and hasn't been revoked.
    pub connected: bool,
    pub account_email: Option<String>,
    pub account_name: Option<String>,
    /// The `file.id` Drive assigned us, if we've ever pushed before.
    pub file_id: Option<String>,
    /// RFC3339 — last successful push *or* pull.
    pub last_synced_at: Option<String>,
    /// True when the master passphrase is cached in RAM (set by the user
    /// via the setup dialog). Auto-sync only runs when this is true.
    #[serde(default)]
    pub passphrase_cached: bool,
}

// ---- config API ----

pub fn load_config(conn: &Connection) -> Result<SyncConfig, AppError> {
    Ok(SyncConfig {
        client_id: kv_get(conn, KV_CLIENT_ID)?.unwrap_or_default(),
        filename: kv_get(conn, KV_FILENAME)?.unwrap_or_else(|| DEFAULT_FILENAME.to_string()),
        enabled: kv_get(conn, KV_ENABLED)?
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
        has_client_secret: crate::secrets::has(SECRET_CLIENT_SECRET).unwrap_or(false),
        has_embedded_creds: has_embedded_creds(),
        auto_sync_interval_min: load_auto_interval(conn)?,
    })
}

/// Auto-sync cadence in minutes (0 = off).
pub fn load_auto_interval(conn: &Connection) -> Result<u32, AppError> {
    Ok(kv_get(conn, KV_AUTO_INTERVAL_MIN)?
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0))
}

pub fn save_auto_interval(conn: &Connection, minutes: u32) -> Result<(), AppError> {
    kv_set(conn, KV_AUTO_INTERVAL_MIN, &minutes.to_string())
}

/// Save user-editable bits of the config. `client_secret` is optional —
/// if `None`, the existing one (if any) is left alone; empty string clears
/// it.
pub fn save_config(
    conn: &Connection,
    client_id: &str,
    client_secret: Option<&str>,
    filename: &str,
    enabled: bool,
) -> Result<(), AppError> {
    kv_set(conn, KV_CLIENT_ID, client_id)?;
    kv_set(
        conn,
        KV_FILENAME,
        if filename.is_empty() {
            DEFAULT_FILENAME
        } else {
            filename
        },
    )?;
    kv_set(conn, KV_ENABLED, if enabled { "1" } else { "0" })?;
    if let Some(secret) = client_secret {
        if secret.is_empty() {
            crate::secrets::clear(SECRET_CLIENT_SECRET)?;
        } else {
            crate::secrets::set(SECRET_CLIENT_SECRET, secret)?;
        }
    }
    Ok(())
}

pub fn load_status(conn: &Connection, runtime: &SyncRuntime) -> Result<SyncStatus, AppError> {
    let config = load_config(conn)?;
    let connected = crate::secrets::has(SECRET_TOKENS).unwrap_or(false);
    Ok(SyncStatus {
        config,
        connected,
        account_email: kv_get(conn, KV_ACCOUNT_EMAIL)?,
        account_name: kv_get(conn, KV_ACCOUNT_NAME)?,
        file_id: kv_get(conn, KV_FILE_ID)?,
        last_synced_at: kv_get(conn, KV_LAST_SYNCED)?,
        passphrase_cached: runtime.has_passphrase(),
    })
}

// ---- tokens ----

fn load_tokens() -> Result<Option<oauth::Tokens>, AppError> {
    match crate::secrets::get(SECRET_TOKENS)? {
        None => Ok(None),
        Some(raw) => serde_json::from_str::<oauth::Tokens>(&raw)
            .map(Some)
            .map_err(|e| AppError::Internal(format!("parse stored tokens: {e}"))),
    }
}

fn save_tokens(tokens: &oauth::Tokens) -> Result<(), AppError> {
    let raw = serde_json::to_string(tokens)
        .map_err(|e| AppError::Internal(format!("serialize tokens: {e}")))?;
    crate::secrets::set(SECRET_TOKENS, &raw)
}

fn clear_tokens() -> Result<(), AppError> {
    crate::secrets::clear(SECRET_TOKENS)
}

/// Return a live, non-expired access token — refreshing transparently if
/// the cached one is within 30 s of expiry. Pulls client credentials from
/// their respective stores.
async fn ensure_fresh_token(conn_mutex: &Arc<Mutex<Connection>>) -> Result<oauth::Tokens, AppError> {
    let mut tokens = load_tokens()?.ok_or_else(|| {
        AppError::InvalidArgument(
            "Google Drive isn't connected — connect an account in Settings → Sync".into(),
        )
    })?;

    if !tokens.is_expired() {
        return Ok(tokens);
    }

    let (client_id, client_secret) = {
        let conn = conn_mutex.lock();
        resolve_creds(&conn)?
    };

    let refreshed = oauth::refresh(&client_id, &client_secret, &tokens.refresh_token).await?;
    // Preserve the existing refresh_token if Google didn't hand back a new
    // one. `oauth::refresh` already does this, but being explicit keeps the
    // invariant obvious here.
    if refreshed.refresh_token.is_empty() {
        tokens.access_token = refreshed.access_token;
        tokens.expires_at = refreshed.expires_at;
        tokens.scope = refreshed.scope;
        tokens.token_type = refreshed.token_type;
    } else {
        tokens = refreshed;
    }
    save_tokens(&tokens)?;
    Ok(tokens)
}

// ---- connect / disconnect ----

/// Run the OAuth flow end-to-end and persist the resulting tokens. `open`
/// is called with the authorisation URL — the caller (Tauri command layer)
/// passes through to `tauri_plugin_shell` or `open::that`.
pub async fn connect<F>(
    conn_mutex: Arc<Mutex<Connection>>,
    runtime: Arc<SyncRuntime>,
    open_browser: F,
) -> Result<SyncStatus, AppError>
where
    F: FnOnce(&str) -> Result<(), AppError>,
{
    let (client_id, client_secret) = {
        let conn = conn_mutex.lock();
        resolve_creds(&conn)?
    };

    let tokens = oauth::run_desktop_flow(&client_id, &client_secret, open_browser).await?;
    save_tokens(&tokens)?;

    // Grab the user's email/name for display. Failure here shouldn't abort
    // the whole connect flow — the tokens are already saved.
    match drive::about_user(&tokens.access_token).await {
        Ok(info) => {
            let conn = conn_mutex.lock();
            if let Some(email) = info.email_address {
                let _ = kv_set(&conn, KV_ACCOUNT_EMAIL, &email);
            }
            if let Some(name) = info.display_name {
                let _ = kv_set(&conn, KV_ACCOUNT_NAME, &name);
            }
        }
        Err(e) => tracing::warn!(error = %e, "drive.about failed after connect; continuing"),
    }

    let conn = conn_mutex.lock();
    load_status(&conn, &runtime)
}

/// Revoke the refresh token at Google and clear every trace locally —
/// including any cached passphrase and the running auto-sync task.
pub async fn disconnect(
    conn_mutex: Arc<Mutex<Connection>>,
    runtime: Arc<SyncRuntime>,
) -> Result<SyncStatus, AppError> {
    // Best-effort revoke — if it fails we still want to scrub local state.
    if let Ok(Some(t)) = load_tokens() {
        oauth::revoke(&t.refresh_token).await;
    }
    clear_tokens()?;

    // Stop auto-sync and forget the cached passphrase so a reconnect from
    // another account doesn't accidentally encrypt with the previous one.
    runtime.abort_task();
    runtime.clear_passphrase();
    let _ = crate::secrets::clear(SECRET_CACHED_PASSPHRASE);

    let conn = conn_mutex.lock();
    kv_delete(&conn, KV_FILE_ID)?;
    kv_delete(&conn, KV_LAST_SYNCED)?;
    kv_delete(&conn, KV_ACCOUNT_EMAIL)?;
    kv_delete(&conn, KV_ACCOUNT_NAME)?;
    kv_delete(&conn, KV_AUTO_INTERVAL_MIN)?;
    load_status(&conn, &runtime)
}

// ---- push / pull ----

/// Assemble a snapshot, encrypt it under `passphrase`, and upload to Drive.
///
/// If we've pushed before, the cached `file_id` is used to update the
/// existing file; otherwise we search for one by name (in case this is a
/// second device with the same file already present) and finally create
/// a fresh one.
pub async fn push(
    conn_mutex: Arc<Mutex<Connection>>,
    runtime: Arc<SyncRuntime>,
    passphrase: String,
) -> Result<SyncStatus, AppError> {
    if passphrase.is_empty() {
        return Err(AppError::InvalidArgument(
            "sync passphrase must not be empty".into(),
        ));
    }

    let (snapshot_json, filename, existing_file_id) = tokio::task::spawn_blocking({
        let conn_mutex = conn_mutex.clone();
        move || -> Result<(Vec<u8>, String, Option<String>), AppError> {
            let conn = conn_mutex.lock();
            let snap = payload::build(&conn)?;
            let json = serde_json::to_vec(&snap)
                .map_err(|e| AppError::Internal(format!("serialize snapshot: {e}")))?;
            let filename = kv_get(&conn, KV_FILENAME)?
                .unwrap_or_else(|| DEFAULT_FILENAME.to_string());
            let file_id = kv_get(&conn, KV_FILE_ID)?;
            Ok((json, filename, file_id))
        }
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    let blob = crypto::encrypt(&passphrase, &snapshot_json)?;

    let tokens = ensure_fresh_token(&conn_mutex).await?;
    let token = tokens.access_token;

    // Prefer the file_id we already know. If it's gone from Drive
    // (user deleted it manually), fall back to a name search.
    let meta = if let Some(id) = existing_file_id.clone() {
        match drive::update(&token, &id, blob.clone()).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, id, "update by known id failed, retrying by name");
                resolve_or_create(&token, &filename, blob).await?
            }
        }
    } else {
        resolve_or_create(&token, &filename, blob).await?
    };

    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = conn_mutex.lock();
        kv_set(&conn, KV_FILE_ID, &meta.id)?;
        kv_set(&conn, KV_LAST_SYNCED, &now)?;
    }

    let conn = conn_mutex.lock();
    load_status(&conn, &runtime)
}

async fn resolve_or_create(
    token: &str,
    filename: &str,
    bytes: Vec<u8>,
) -> Result<drive::FileMeta, AppError> {
    if let Some(existing) = drive::find_by_name(token, filename).await? {
        drive::update(token, &existing.id, bytes).await
    } else {
        drive::upload_new(token, filename, bytes).await
    }
}

/// Download the snapshot, decrypt, apply locally. Returns stats for the
/// UI toast.
pub async fn pull(
    conn_mutex: Arc<Mutex<Connection>>,
    passphrase: String,
) -> Result<ApplyStats, AppError> {
    if passphrase.is_empty() {
        return Err(AppError::InvalidArgument(
            "sync passphrase must not be empty".into(),
        ));
    }

    let (filename, existing_file_id) = {
        let conn = conn_mutex.lock();
        let filename = kv_get(&conn, KV_FILENAME)?
            .unwrap_or_else(|| DEFAULT_FILENAME.to_string());
        let file_id = kv_get(&conn, KV_FILE_ID)?;
        (filename, file_id)
    };

    let tokens = ensure_fresh_token(&conn_mutex).await?;
    let token = tokens.access_token;

    // Find the file. Prefer the cached id, but verify it still exists.
    let meta = match existing_file_id {
        Some(id) => match drive::download(&token, &id).await {
            Ok(_bytes) => {
                // We need full metadata too (for fileId to stay pinned) —
                // but we already have the id. Just re-construct a minimal
                // FileMeta; the real one isn't needed beyond the id.
                drive::FileMeta {
                    id,
                    name: filename.clone(),
                    modified_time: None,
                    size: None,
                }
            }
            Err(_) => drive::find_by_name(&token, &filename).await?.ok_or_else(|| {
                AppError::NotFound(format!(
                    "no file named `{filename}` in your Google Drive — push from another device first"
                ))
            })?,
        },
        None => drive::find_by_name(&token, &filename).await?.ok_or_else(|| {
            AppError::NotFound(format!(
                "no file named `{filename}` in your Google Drive — push from another device first"
            ))
        })?,
    };

    let blob = drive::download(&token, &meta.id).await?;
    let plaintext = crypto::decrypt(&passphrase, &blob)?;
    let snap: payload::Snapshot = serde_json::from_slice(&plaintext)
        .map_err(|e| AppError::Internal(format!("parse snapshot: {e}")))?;

    let stats = tokio::task::spawn_blocking({
        let conn_mutex = conn_mutex.clone();
        move || -> Result<ApplyStats, AppError> {
            let mut conn = conn_mutex.lock();
            payload::apply(&mut conn, snap)
        }
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = conn_mutex.lock();
        kv_set(&conn, KV_FILE_ID, &meta.id)?;
        kv_set(&conn, KV_LAST_SYNCED, &now)?;
    }

    Ok(stats)
}

// ---- file-based export / import (no cloud) ----
//
// Dumps the same snapshot format to a local file instead of Drive. Same
// crypto envelope (`PROSSHSYNC01`) so a file exported on one device can be
// imported on another via any transport the user prefers — USB stick,
// email attachment, Dropbox, Yandex.Disk, etc. This bypasses the whole
// OAuth / Google-Cloud setup and is the recommended path for most users.

/// Build a snapshot, encrypt under `passphrase`, and write the opaque blob
/// to `path`. Caller is responsible for picking `path` via a save dialog.
pub async fn export_to_file(
    conn_mutex: Arc<Mutex<Connection>>,
    passphrase: String,
    path: String,
) -> Result<(), AppError> {
    if passphrase.is_empty() {
        return Err(AppError::InvalidArgument(
            "sync passphrase must not be empty".into(),
        ));
    }
    if path.is_empty() {
        return Err(AppError::InvalidArgument(
            "export path must not be empty".into(),
        ));
    }

    // Build the snapshot on the blocking pool — DB I/O + secrets fetches.
    let snapshot_json = tokio::task::spawn_blocking({
        let conn_mutex = conn_mutex.clone();
        move || -> Result<Vec<u8>, AppError> {
            let conn = conn_mutex.lock();
            let snap = payload::build(&conn)?;
            serde_json::to_vec(&snap)
                .map_err(|e| AppError::Internal(format!("serialize snapshot: {e}")))
        }
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    let blob = crypto::encrypt(&passphrase, &snapshot_json)?;

    tokio::task::spawn_blocking(move || {
        std::fs::write(&path, &blob)
            .map_err(|e| AppError::Internal(format!("write {path}: {e}")))
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    Ok(())
}

/// Read `path`, decrypt under `passphrase`, apply the snapshot. Returns
/// merge stats for the UI toast. "Remote wins" semantics — same as pull
/// from Drive.
pub async fn import_from_file(
    conn_mutex: Arc<Mutex<Connection>>,
    passphrase: String,
    path: String,
) -> Result<ApplyStats, AppError> {
    if passphrase.is_empty() {
        return Err(AppError::InvalidArgument(
            "sync passphrase must not be empty".into(),
        ));
    }
    if path.is_empty() {
        return Err(AppError::InvalidArgument(
            "import path must not be empty".into(),
        ));
    }

    let blob = tokio::task::spawn_blocking({
        let path = path.clone();
        move || {
            std::fs::read(&path).map_err(|e| AppError::Internal(format!("read {path}: {e}")))
        }
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    let plaintext = crypto::decrypt(&passphrase, &blob)?;
    let snap: payload::Snapshot = serde_json::from_slice(&plaintext)
        .map_err(|e| AppError::Internal(format!("parse snapshot: {e}")))?;

    let stats = tokio::task::spawn_blocking({
        let conn_mutex = conn_mutex.clone();
        move || -> Result<ApplyStats, AppError> {
            let mut conn = conn_mutex.lock();
            payload::apply(&mut conn, snap)
        }
    })
    .await
    .map_err(|e| AppError::Internal(format!("blocking join: {e}")))??;

    // Note: we deliberately don't touch KV_LAST_SYNCED here — that key
    // tracks Drive sync, and overwriting it on a file import would make
    // the "last synced" label misleading.
    Ok(stats)
}

// ---- passphrase persistence (opt-in "remember on this device") ----

/// Stash the master passphrase in the secret backend so the auto-sync loop
/// can resume after a process restart without re-prompting. The user opts
/// in via the setup dialog — it's *not* enabled silently.
pub fn remember_passphrase(passphrase: &str) -> Result<(), AppError> {
    crate::secrets::set(SECRET_CACHED_PASSPHRASE, passphrase)
}

/// Wipe the persisted passphrase. The in-memory cache is independent — that
/// stays alive until the process exits or the user clicks "Forget".
pub fn forget_passphrase() -> Result<(), AppError> {
    crate::secrets::clear(SECRET_CACHED_PASSPHRASE)
}

/// Try to fetch a previously-remembered passphrase. Returns `Ok(None)` when
/// nothing is stored or when the secret backend is currently unavailable
/// (e.g. encrypted vault not yet unlocked) — the caller treats either case
/// the same: auto-sync is paused until a passphrase shows up.
pub fn restore_passphrase() -> Option<String> {
    crate::secrets::get(SECRET_CACHED_PASSPHRASE)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

// ---- auto-sync loop ----

/// Spawn (or respawn) the background auto-sync task. Always abort()s any
/// previously-running task — calling this on every config change is the
/// idiomatic way to apply a new interval.
///
/// Becomes a no-op when:
/// - the interval is 0 (auto-sync disabled), or
/// - no OAuth tokens are stored (not connected to Drive)
///
/// The task runs forever once spawned. Each tick:
/// 1. Sleeps for `interval_min` minutes.
/// 2. Reads the cached passphrase. If absent, emits `sync-auto-skipped`
///    and waits for the next tick — UI shows "passphrase needed".
/// 3. Pulls (apply remote → local), then pushes (re-snapshot → remote).
///    Errors at either step are emitted as `sync-auto-error` but don't
///    kill the loop.
///
/// Pull-then-push is the right order for a *single user, multiple
/// devices* scenario: pulling first applies anything the other device
/// uploaded since our last cycle, and pushing afterwards lets local
/// edits propagate back. Conflicts use "remote wins" semantics; for
/// real concurrent editing on two devices the user can disable
/// auto-sync and resolve manually.
pub fn start_auto_sync(
    conn_mutex: Arc<Mutex<Connection>>,
    runtime: Arc<SyncRuntime>,
    app: AppHandle,
) -> Result<(), AppError> {
    runtime.abort_task();

    let interval_min = {
        let conn = conn_mutex.lock();
        load_auto_interval(&conn)?
    };
    if interval_min == 0 {
        tracing::debug!("auto-sync disabled (interval=0)");
        return Ok(());
    }
    if !crate::secrets::has(SECRET_TOKENS).unwrap_or(false) {
        tracing::debug!("auto-sync not started: no OAuth tokens");
        return Ok(());
    }

    tracing::info!(interval_min, "auto-sync task starting");
    let conn_for_task = conn_mutex.clone();
    let runtime_for_task = runtime.clone();
    let app_for_task = app.clone();
    // tauri::async_runtime::spawn — not tokio::spawn — because this can be
    // called from Tauri's setup() closure, which on Windows is not inside a
    // tokio runtime context. Raw tokio::spawn there aborts the process with
    // "there is no reactor running" (panic=abort in release).
    let handle = tauri::async_runtime::spawn(async move {
        let interval = std::time::Duration::from_secs((interval_min as u64).saturating_mul(60));
        loop {
            tokio::time::sleep(interval).await;
            run_auto_sync_once(&conn_for_task, &runtime_for_task, &app_for_task).await;
        }
    });

    runtime.install_task(handle);
    Ok(())
}

/// One iteration of the auto-sync loop, factored out for clarity.
async fn run_auto_sync_once(
    conn_mutex: &Arc<Mutex<Connection>>,
    runtime: &Arc<SyncRuntime>,
    app: &AppHandle,
) {
    let pass = match runtime.passphrase() {
        Some(p) => p,
        None => {
            tracing::debug!("auto-sync: no cached passphrase — skipping");
            let _ = app.emit(EVT_AUTO_SKIPPED, "no passphrase");
            return;
        }
    };

    // Pull first so we apply remote changes before clobbering them. If pull
    // fails for any reason other than NotFound we MUST skip the push — the
    // remote file is real, we just couldn't read it, and pushing would
    // overwrite another device's data with our (possibly stale or empty)
    // local snapshot. NotFound is the first-device case where a push is
    // appropriate (it'll create the file).
    match pull(conn_mutex.clone(), pass.clone()).await {
        Ok(stats) => {
            tracing::info!(?stats, "auto-sync pull ok");
            let _ = app.emit(EVT_AUTO_PULLED, &stats);
        }
        Err(AppError::NotFound(_)) => {
            tracing::debug!("auto-sync: remote file missing — push will create it");
        }
        Err(e) => {
            tracing::warn!(error = %e, "auto-sync pull failed — skipping push");
            let _ = app.emit(EVT_AUTO_ERROR, format!("pull: {e}"));
            return;
        }
    }

    match push(conn_mutex.clone(), runtime.clone(), pass).await {
        Ok(_) => {
            tracing::info!("auto-sync push ok");
            let _ = app.emit(EVT_AUTO_PUSHED, ());
        }
        Err(e) => {
            tracing::warn!(error = %e, "auto-sync push failed");
            let _ = app.emit(EVT_AUTO_ERROR, format!("push: {e}"));
        }
    }
}
