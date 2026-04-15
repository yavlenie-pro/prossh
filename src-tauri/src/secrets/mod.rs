//! Secret storage for session passwords and key passphrases.
//!
//! Two backends are supported:
//!
//! - **OS keyring** — Windows Credential Manager / macOS Keychain / Secret
//!   Service on Linux. Zero configuration on most desktops, but on minimal
//!   Linux setups (headless Arch, TTY-only, CI) the Secret Service isn't
//!   reachable and the backend fails hard.
//! - **Encrypted file vault** — Argon2id + AES-256-GCM over a single file at
//!   `<data_dir>/prossh/secrets.vault`, unlocked with a master password the
//!   user picks. Works everywhere.
//!
//! The choice is persisted in the `secrets.backend` key of the settings KV
//! table (`"auto"`, `"keyring"`, or `"file"`). In `auto` mode we probe the
//! OS keyring at startup and fall back to the file vault if it's unavailable.
//!
//! The frontend never sees plaintext secrets — it can only check presence
//! (`has`), write (`set`), or clear. Retrieval happens server-side during
//! SSH connect.

pub mod file_backend;

use std::path::PathBuf;
use std::sync::OnceLock;

use keyring::Entry;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use file_backend::FileBackend;

const SERVICE: &str = "prossh";

/// Which backend was requested by the user. `Auto` is resolved to either
/// `Keyring` or `File` at init time based on what's actually available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Auto,
    Keyring,
    File,
}

impl BackendKind {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "keyring" | "os" | "os-keyring" => Some(Self::Keyring),
            "file" | "vault" | "encrypted" => Some(Self::File),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Keyring => "keyring",
            Self::File => "file",
        }
    }
}

// ---- keyring backend helpers ----

fn is_backend_unavailable(err: &keyring::Error) -> bool {
    matches!(
        err,
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
    )
}

fn backend_unavailable_hint() -> String {
    if cfg!(target_os = "linux") {
        "OS secure storage is unavailable — install and start a Secret \
         Service provider (e.g. gnome-keyring), or switch to the encrypted \
         file vault in Settings → Security."
            .into()
    } else {
        "OS secure storage is unavailable — switch to the encrypted file \
         vault in Settings → Security."
            .into()
    }
}

fn open_entry(key: &str) -> Result<Entry, keyring::Error> {
    Entry::new(SERVICE, key)
}

/// Lightweight probe for whether the OS keyring actually works on this host.
/// We don't care about the value — just whether opening a dummy entry and
/// asking for its password returns something other than a backend error.
fn keyring_available() -> bool {
    let entry = match open_entry("__prossh_probe__") {
        Ok(e) => e,
        Err(ref e) if is_backend_unavailable(e) => return false,
        Err(_) => return true, // some other error, but backend is reachable
    };
    match entry.get_password() {
        Ok(_) => true,
        Err(keyring::Error::NoEntry) => true,
        Err(ref e) if is_backend_unavailable(e) => false,
        Err(_) => true,
    }
}

fn keyring_set(key: &str, secret: &str) -> Result<(), AppError> {
    match open_entry(key).and_then(|e| e.set_password(secret)) {
        Ok(()) => Ok(()),
        Err(ref e) if is_backend_unavailable(e) => {
            tracing::warn!(key, error = %e, "keyring backend unavailable on set");
            Err(AppError::Secret(backend_unavailable_hint()))
        }
        Err(e) => Err(AppError::Secret(format!("set {key}: {e}"))),
    }
}

fn keyring_get(key: &str) -> Result<Option<String>, AppError> {
    let entry = match open_entry(key) {
        Ok(e) => e,
        Err(ref e) if is_backend_unavailable(e) => {
            tracing::warn!(key, error = %e, "keyring backend unavailable on get");
            return Ok(None);
        }
        Err(e) => return Err(AppError::Secret(format!("open entry {key}: {e}"))),
    };
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(ref e) if is_backend_unavailable(e) => Ok(None),
        Err(e) => Err(AppError::Secret(format!("get {key}: {e}"))),
    }
}

fn keyring_has(key: &str) -> Result<bool, AppError> {
    let entry = match open_entry(key) {
        Ok(e) => e,
        Err(ref e) if is_backend_unavailable(e) => return Ok(false),
        Err(e) => return Err(AppError::Secret(format!("open entry {key}: {e}"))),
    };
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(ref e) if is_backend_unavailable(e) => Ok(false),
        Err(e) => Err(AppError::Secret(format!("has {key}: {e}"))),
    }
}

fn keyring_clear(key: &str) -> Result<(), AppError> {
    let entry = match open_entry(key) {
        Ok(e) => e,
        Err(ref e) if is_backend_unavailable(e) => return Ok(()),
        Err(e) => return Err(AppError::Secret(format!("open entry {key}: {e}"))),
    };
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(ref e) if is_backend_unavailable(e) => Ok(()),
        Err(e) => Err(AppError::Secret(format!("clear {key}: {e}"))),
    }
}

// ---- manager ----

/// Report describing the current state of the secret store — consumed by the
/// frontend to decide what UI to show (unlock prompt, "vault locked" badge,
/// "keyring unavailable" warning, …).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    /// What the user picked — may be `Auto`.
    pub configured: BackendKind,
    /// What we're actually using right now — never `Auto`.
    pub effective: BackendKind,
    /// True when the OS keyring passes a live probe.
    pub keyring_available: bool,
    /// True when the encrypted vault file exists on disk.
    pub file_exists: bool,
    /// True when the encrypted vault is currently unlocked in this process.
    pub file_unlocked: bool,
}

pub struct SecretsManager {
    configured: BackendKind,
    effective: BackendKind,
    keyring_available: bool,
    file: FileBackend,
}

impl SecretsManager {
    fn new(vault_path: PathBuf, configured: BackendKind) -> Self {
        let keyring_ok = keyring_available();
        let effective = match configured {
            BackendKind::Auto => {
                if keyring_ok {
                    BackendKind::Keyring
                } else {
                    BackendKind::File
                }
            }
            BackendKind::Keyring => BackendKind::Keyring,
            BackendKind::File => BackendKind::File,
        };
        Self {
            configured,
            effective,
            keyring_available: keyring_ok,
            file: FileBackend::new(vault_path),
        }
    }

    pub fn status(&self) -> BackendStatus {
        BackendStatus {
            configured: self.configured,
            effective: self.effective,
            keyring_available: self.keyring_available,
            file_exists: self.file.exists(),
            file_unlocked: self.file.is_unlocked(),
        }
    }

    /// Re-probe the OS keyring and recompute the effective backend based on
    /// `new_configured`. Does NOT touch the file vault's unlocked state —
    /// flipping between backends is cheap.
    pub fn set_configured(&mut self, new_configured: BackendKind) {
        self.configured = new_configured;
        self.keyring_available = keyring_available();
        self.effective = match new_configured {
            BackendKind::Auto => {
                if self.keyring_available {
                    BackendKind::Keyring
                } else {
                    BackendKind::File
                }
            }
            BackendKind::Keyring => BackendKind::Keyring,
            BackendKind::File => BackendKind::File,
        };
        tracing::info!(
            configured = ?self.configured,
            effective = ?self.effective,
            "secret backend reconfigured"
        );
    }
}

static MANAGER: OnceLock<RwLock<SecretsManager>> = OnceLock::new();

/// Initialise the global manager. Called once from `AppState::new` after
/// the settings KV has been consulted. Subsequent calls are a no-op so
/// tests / double-init don't blow up.
pub fn init(vault_path: PathBuf, configured: BackendKind) {
    let _ = MANAGER.set(RwLock::new(SecretsManager::new(vault_path, configured)));
}

fn with_manager_read<R>(f: impl FnOnce(&SecretsManager) -> R) -> R {
    let mgr = MANAGER
        .get()
        .expect("secret manager not initialised — call secrets::init first");
    f(&mgr.read())
}

fn with_manager_write<R>(f: impl FnOnce(&mut SecretsManager) -> R) -> R {
    let mgr = MANAGER
        .get()
        .expect("secret manager not initialised — call secrets::init first");
    f(&mut mgr.write())
}

// ---- public API used by commands/pty.rs, sftp.rs, ssh.rs ----

/// Store (or overwrite) a secret for the given key.
pub fn set(key: &str, secret: &str) -> Result<(), AppError> {
    with_manager_write(|mgr| match mgr.effective {
        BackendKind::Keyring => keyring_set(key, secret),
        BackendKind::File => mgr.file.set(key, secret),
        BackendKind::Auto => unreachable!("effective backend is never Auto"),
    })
}

/// Fetch the plaintext secret. `Ok(None)` if not present.
///
/// For the file backend: returns `Ok(None)` when the vault is locked so
/// that connect flows can gracefully fall back to prompting the user for
/// a password. The UI should have already shown an unlock dialog by this
/// point if the user asked for persistence.
pub fn get(key: &str) -> Result<Option<String>, AppError> {
    with_manager_read(|mgr| match mgr.effective {
        BackendKind::Keyring => keyring_get(key),
        BackendKind::File => {
            if !mgr.file.is_unlocked() {
                return Ok(None);
            }
            mgr.file.get(key)
        }
        BackendKind::Auto => unreachable!("effective backend is never Auto"),
    })
}

/// Returns whether a secret is currently stored.
pub fn has(key: &str) -> Result<bool, AppError> {
    with_manager_read(|mgr| match mgr.effective {
        BackendKind::Keyring => keyring_has(key),
        BackendKind::File => {
            if !mgr.file.is_unlocked() {
                return Ok(false);
            }
            mgr.file.has(key)
        }
        BackendKind::Auto => unreachable!("effective backend is never Auto"),
    })
}

/// Delete the stored secret (no-op if none exists).
pub fn clear(key: &str) -> Result<(), AppError> {
    with_manager_write(|mgr| match mgr.effective {
        BackendKind::Keyring => keyring_clear(key),
        BackendKind::File => {
            if !mgr.file.is_unlocked() {
                // Nothing to do — you can't remove from a locked vault, but
                // callers invoke clear() unconditionally during cleanup, so
                // pretend it worked.
                return Ok(());
            }
            mgr.file.clear(key)
        }
        BackendKind::Auto => unreachable!("effective backend is never Auto"),
    })
}

// ---- vault management (consumed by commands/secrets.rs) ----

pub fn status() -> BackendStatus {
    with_manager_read(|mgr| mgr.status())
}

pub fn set_backend(new: BackendKind) {
    with_manager_write(|mgr| mgr.set_configured(new))
}

pub fn vault_create(password: &str) -> Result<(), AppError> {
    with_manager_write(|mgr| mgr.file.create(password))
}

pub fn vault_unlock(password: &str) -> Result<(), AppError> {
    with_manager_write(|mgr| mgr.file.unlock(password))
}

pub fn vault_lock() {
    with_manager_write(|mgr| mgr.file.lock())
}

pub fn vault_change_password(old: &str, new: &str) -> Result<(), AppError> {
    with_manager_write(|mgr| mgr.file.change_password(old, new))
}

pub fn vault_destroy() -> Result<(), AppError> {
    with_manager_write(|mgr| mgr.file.destroy())
}
