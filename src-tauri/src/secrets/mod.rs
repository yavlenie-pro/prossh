//! OS keychain integration for storing session passwords and key passphrases.
//!
//! The backend is the only place raw secrets live — the frontend can ask
//! whether a secret exists (`has`), write a new one (`set`), or drop one
//! (`clear`), but never read the plaintext. Retrieval happens server-side
//! during SSH connect (step 5+).
//!
//! Service name is `"prossh"` (lowercase — matches the OS app id). Account
//! names come from [`crate::sessions::secret_key`] so renames don't lose the
//! credential.

use keyring::Entry;

use crate::error::AppError;

const SERVICE: &str = "prossh";

fn open(key: &str) -> Result<Entry, AppError> {
    Entry::new(SERVICE, key)
        .map_err(|e| AppError::Secret(format!("open entry {key}: {e}")))
}

/// Store (or overwrite) a secret for the given key.
pub fn set(key: &str, secret: &str) -> Result<(), AppError> {
    open(key)?
        .set_password(secret)
        .map_err(|e| AppError::Secret(format!("set {key}: {e}")))
}

/// Fetch the plaintext secret. Returns `Ok(None)` if no entry exists —
/// call sites should treat that as "user will be prompted at connect time".
/// Called from [`crate::commands::ssh::ssh_test_connect`] (step 5+).
pub fn get(key: &str) -> Result<Option<String>, AppError> {
    match open(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Secret(format!("get {key}: {e}"))),
    }
}

/// Returns whether a secret is currently stored. Used by the UI to show a
/// "stored" badge next to the password field when editing a session.
pub fn has(key: &str) -> Result<bool, AppError> {
    match open(key)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(AppError::Secret(format!("has {key}: {e}"))),
    }
}

/// Delete the stored secret. Treats "not present" as success so callers can
/// invoke this unconditionally during cleanup (session delete, etc.).
pub fn clear(key: &str) -> Result<(), AppError> {
    match open(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Secret(format!("clear {key}: {e}"))),
    }
}
