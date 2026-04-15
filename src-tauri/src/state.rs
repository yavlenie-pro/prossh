//! Application-wide state shared across Tauri commands.
//!
//! Progressive build-up by milestone:
//!
//! - step 2 — [`Database`]
//! - step 4 — [`KnownHostsStore`]
//! - step 6 — `ssh_sessions: Arc<RwLock<HashMap<String, Arc<SshSession>>>>`
//! - step 9 — `host_key_gate: Arc<HostKeyGate>`
//! - step 12 — `sftp_sessions: Arc<RwLock<HashMap<String, Arc<SftpSession>>>>`

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::db::Database;
use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::sftp::SftpMap;
use crate::ssh::gate::PromptMap;
use crate::ssh::pty::SessionMap;
use crate::sync::SyncRuntime;

/// Active transfer cancellation tokens keyed by `transfer_id`.
pub type TransferCancellations = Arc<RwLock<HashMap<String, CancellationToken>>>;

/// Resolved on-disk locations the backend writes to.
#[derive(Debug, Clone)]
pub struct AppPaths {
    /// `<data_dir>/prossh/` — holds `prossh.sqlite` and other persistent files.
    pub data_dir: PathBuf,
    /// `<config_dir>/prossh/` — holds user-editable JSON (e.g. fallback known_hosts).
    pub config_dir: PathBuf,
}

impl AppPaths {
    pub fn resolve() -> Result<Self, AppError> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| AppError::Setup("could not resolve data dir".into()))?
            .join("prossh");
        let config_dir = dirs::config_dir()
            .ok_or_else(|| AppError::Setup("could not resolve config dir".into()))?
            .join("prossh");

        std::fs::create_dir_all(&data_dir)
            .map_err(|e| AppError::Setup(format!("create data dir: {e}")))?;
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| AppError::Setup(format!("create config dir: {e}")))?;

        Ok(Self {
            data_dir,
            config_dir,
        })
    }

    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join("prossh.sqlite")
    }

    pub fn known_hosts_path(&self) -> PathBuf {
        self.config_dir.join("known_hosts.json")
    }

    /// Encrypted secret vault used when the OS keyring isn't available.
    pub fn secrets_vault_path(&self) -> PathBuf {
        self.data_dir.join("secrets.vault")
    }
}

/// Top-level state managed by Tauri (`app.manage(state)`).
#[derive(Clone)]
pub struct AppState {
    pub paths: AppPaths,
    pub db: Database,
    pub known_hosts: Arc<KnownHostsStore>,
    /// Live SSH/PTY sessions keyed by `runtime_id`.
    pub ssh_sessions: SessionMap,
    /// Pending passphrase prompts — the value is the entered passphrase string
    /// (or empty string to cancel).
    pub passphrase_gate: PromptMap<String>,
    /// Pending host-key prompts (step 9) — value is `true` = accept, `false` = reject.
    pub host_key_gate: PromptMap<bool>,
    /// Pending credentials prompts (username + password).
    pub credentials_gate: PromptMap<crate::ssh::pty::CredentialsResponse>,
    /// Live SFTP sessions keyed by `runtime_id`.
    pub sftp_sessions: SftpMap,
    /// Active transfer cancellation tokens keyed by `transfer_id`.
    pub transfer_cancellations: TransferCancellations,
    /// Cached sync passphrase + handle of the auto-sync background task.
    /// Outlives individual commands so the loop can encrypt without
    /// re-prompting on every tick.
    pub sync_runtime: Arc<SyncRuntime>,
}

impl AppState {
    pub fn new(_app: &AppHandle) -> Result<Self, AppError> {
        let paths = AppPaths::resolve()?;
        let db = Database::open(&paths.database_path())?;

        // Initialise the global secret manager as soon as we know where the
        // vault file lives and which backend the user selected last time.
        // Reading from `settings` here means the SQLite connection has to
        // be open first — hence the ordering.
        {
            use rusqlite::OptionalExtension;
            let backend = {
                let conn = db.conn.lock();
                conn.query_row(
                    "SELECT value FROM settings WHERE key = 'secrets.backend'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| AppError::Database(format!("read secrets.backend: {e}")))?
                .and_then(|v| crate::secrets::BackendKind::from_str(&v))
                .unwrap_or(crate::secrets::BackendKind::Auto)
            };
            crate::secrets::init(paths.secrets_vault_path(), backend);
        }

        let known_hosts = Arc::new(KnownHostsStore::load(&paths.known_hosts_path())?);
        let ssh_sessions = crate::ssh::pty::new_session_map();
        let passphrase_gate = crate::ssh::gate::new_prompt_map();
        let host_key_gate = crate::ssh::gate::new_prompt_map();
        let credentials_gate = crate::ssh::gate::new_prompt_map();
        let sftp_sessions = crate::sftp::new_sftp_map();
        let transfer_cancellations: TransferCancellations = Arc::new(RwLock::new(HashMap::new()));
        let sync_runtime = SyncRuntime::new();
        tracing::info!(?paths, "app state initialized");
        Ok(Self {
            paths,
            db,
            known_hosts,
            ssh_sessions,
            passphrase_gate,
            host_key_gate,
            credentials_gate,
            sftp_sessions,
            transfer_cancellations,
            sync_runtime,
        })
    }
}
