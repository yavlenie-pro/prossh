//! Known-hosts store — JSON-backed list of trusted SSH host keys.
//!
//! We intentionally don't use OpenSSH's `~/.ssh/known_hosts` format: it's
//! awkward to parse, its hash-based host entries are hostile to editing, and
//! it doesn't carry the metadata we want (comments, `added_at` timestamps).
//! Instead we keep our own JSON file in ProSSH's config dir. A future step
//! can add import/export against the OpenSSH format if needed.
//!
//! File layout (`<config_dir>/known_hosts.json`):
//!
//! ```json
//! {
//!   "version": 1,
//!   "entries": [
//!     {
//!       "host": "example.com",
//!       "port": 22,
//!       "algorithm": "ssh-ed25519",
//!       "fingerprint": "SHA256:AbCdEf...",
//!       "comment": null,
//!       "addedAt": "2026-04-10T04:10:00Z"
//!     }
//!   ]
//! }
//! ```
//!
//! Lookup key is the tuple `(host, port, algorithm)`. Multiple algorithms for
//! the same `(host, port)` are allowed — a server may advertise several host
//! keys and we trust whichever one the user accepted.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// A single trusted host key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    /// SSH host key algorithm, e.g. `ssh-ed25519`, `rsa-sha2-512`.
    pub algorithm: String,
    /// Fingerprint in OpenSSH format (`SHA256:<base64>`).
    pub fingerprint: String,
    pub comment: Option<String>,
    pub added_at: DateTime<Utc>,
}

/// Wire format for the JSON file. Version wrapper leaves room for future
/// migrations without breaking deserialisation.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileContents {
    version: u32,
    #[serde(default)]
    entries: Vec<KnownHostEntry>,
}

impl Default for FileContents {
    fn default() -> Self {
        Self {
            version: 1,
            entries: Vec::new(),
        }
    }
}

/// Result of comparing an incoming host key against the store.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // Match/Mismatch/Unknown are consumed by step 5+ (SSH connect flow)
pub enum HostKeyMatch {
    /// The host:port:algorithm tuple exists and the fingerprint matches.
    Match,
    /// The host:port:algorithm tuple exists but the fingerprint is different.
    /// This means the server key changed — MITM or a legitimate rotation.
    Mismatch {
        stored: String,
        incoming: String,
    },
    /// No entry for this host:port:algorithm exists.
    Unknown,
}

/// Thread-safe known-hosts store. Changes are persisted to disk synchronously
/// via atomic file replacement (`write tmp -> rename`).
pub struct KnownHostsStore {
    path: PathBuf,
    state: Mutex<Vec<KnownHostEntry>>,
}

impl std::fmt::Debug for KnownHostsStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KnownHostsStore")
            .field("path", &self.path)
            .field("len", &self.state.lock().len())
            .finish()
    }
}

impl KnownHostsStore {
    /// Load the store from `path`. Missing file is treated as an empty store;
    /// a corrupt file surfaces as [`AppError::Serde`].
    pub fn load(path: &Path) -> Result<Self, AppError> {
        let entries = if path.exists() {
            let bytes = std::fs::read(path)
                .map_err(|e| AppError::Io(format!("read {}: {e}", path.display())))?;
            let parsed: FileContents = serde_json::from_slice(&bytes)?;
            parsed.entries
        } else {
            Vec::new()
        };

        tracing::info!(path = %path.display(), count = entries.len(), "known_hosts loaded");

        Ok(Self {
            path: path.to_path_buf(),
            state: Mutex::new(entries),
        })
    }

    /// Return a snapshot of all trusted entries.
    pub fn list(&self) -> Vec<KnownHostEntry> {
        self.state.lock().clone()
    }

    /// Add or replace an entry in memory and persist to disk.
    #[allow(dead_code)]
    pub fn add(&self, entry: KnownHostEntry) -> Result<(), AppError> {
        self.add_memory(entry);
        self.persist()
    }

    /// Add or replace an entry in memory only (no disk write).
    /// Use [`persist`] or [`persist_background`] afterward.
    pub fn add_memory(&self, entry: KnownHostEntry) {
        let mut state = self.state.lock();
        if let Some(existing) = state.iter_mut().find(|e| {
            e.host == entry.host && e.port == entry.port && e.algorithm == entry.algorithm
        }) {
            *existing = entry;
        } else {
            state.push(entry);
        }
    }

    /// Remove a single `(host, port, algorithm)` entry. Returns whether
    /// anything was removed.
    pub fn remove(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
    ) -> Result<bool, AppError> {
        let removed = {
            let mut state = self.state.lock();
            let before = state.len();
            state.retain(|e| !(e.host == host && e.port == port && e.algorithm == algorithm));
            before != state.len()
        };
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    /// Remove every entry matching a `(host, port)` pair, regardless of
    /// algorithm. Returns the number of removed entries.
    pub fn clear_host(&self, host: &str, port: u16) -> Result<usize, AppError> {
        let removed = {
            let mut state = self.state.lock();
            let before = state.len();
            state.retain(|e| !(e.host == host && e.port == port));
            before - state.len()
        };
        if removed > 0 {
            self.persist()?;
        }
        Ok(removed)
    }

    /// Compare an incoming host key against the store.
    #[allow(dead_code)] // used by SSH connect flow in step 5/9
    pub fn check(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
        fingerprint: &str,
    ) -> HostKeyMatch {
        let state = self.state.lock();
        match state
            .iter()
            .find(|e| e.host == host && e.port == port && e.algorithm == algorithm)
        {
            Some(e) if e.fingerprint == fingerprint => HostKeyMatch::Match,
            Some(e) => HostKeyMatch::Mismatch {
                stored: e.fingerprint.clone(),
                incoming: fingerprint.to_string(),
            },
            None => HostKeyMatch::Unknown,
        }
    }

    /// Atomically write the current state to disk. The write goes to a
    /// sibling `.tmp` file which is then renamed into place — on Windows
    /// since Rust 1.52 and on POSIX since forever, that rename is atomic.
    pub fn persist(&self) -> Result<(), AppError> {
        let contents = FileContents {
            version: 1,
            entries: self.state.lock().clone(),
        };
        let json = serde_json::to_vec_pretty(&contents)?;

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Io(format!("create_dir_all {}: {e}", parent.display()))
            })?;
        }

        let mut tmp = self.path.clone();
        tmp.set_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(|e| {
            AppError::Io(format!("write {}: {e}", tmp.display()))
        })?;
        std::fs::rename(&tmp, &self.path).map_err(|e| {
            AppError::Io(format!("rename {} -> {}: {e}", tmp.display(), self.path.display()))
        })?;

        Ok(())
    }
}
