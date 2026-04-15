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
//!
//! ## Graceful degradation on Linux
//!
//! On minimal Linux setups (Arch without a desktop, tty-only sessions, some
//! WMs without a DBus session bus) the Secret Service backend is simply not
//! reachable. Rather than propagate that as a hard failure that blocks the
//! whole connect flow — which is what users saw reported as "doesn't work on
//! Arch" — treat a missing backend the same as a missing entry: the caller
//! falls back to prompting the user for the password and the app keeps
//! working, just without persistent credential storage.
//!
//! `set()` is the exception: if the user explicitly asked to save a password
//! and the backend isn't available, surface a friendly message so they know
//! why nothing got saved.

use keyring::Entry;

use crate::error::AppError;

const SERVICE: &str = "prossh";

/// Returns true if this error means the OS keyring backend itself is
/// unavailable — e.g., no DBus session bus, no Secret Service provider
/// running — as opposed to a specific entry being missing or malformed.
fn is_backend_unavailable(err: &keyring::Error) -> bool {
    matches!(
        err,
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
    )
}

/// User-facing hint for when the backend isn't reachable. Kept short so it
/// reads well in an error toast.
fn backend_unavailable_hint() -> String {
    if cfg!(target_os = "linux") {
        "OS secure storage is unavailable — install and start a Secret \
         Service provider (e.g. gnome-keyring) so ProSSH can persist \
         passwords."
            .into()
    } else {
        "OS secure storage is unavailable on this system.".into()
    }
}

fn open(key: &str) -> Result<Entry, keyring::Error> {
    Entry::new(SERVICE, key)
}

/// Store (or overwrite) a secret for the given key.
pub fn set(key: &str, secret: &str) -> Result<(), AppError> {
    match open(key).and_then(|e| e.set_password(secret)) {
        Ok(()) => Ok(()),
        Err(ref e) if is_backend_unavailable(e) => {
            tracing::warn!(key, error = %e, "keyring backend unavailable on set");
            Err(AppError::Secret(backend_unavailable_hint()))
        }
        Err(e) => Err(AppError::Secret(format!("set {key}: {e}"))),
    }
}

/// Fetch the plaintext secret. Returns `Ok(None)` if no entry exists OR if
/// the OS keyring backend itself is unreachable — call sites treat that as
/// "user will be prompted at connect time".
pub fn get(key: &str) -> Result<Option<String>, AppError> {
    let entry = match open(key) {
        Ok(e) => e,
        Err(ref e) if is_backend_unavailable(e) => {
            tracing::warn!(key, error = %e, "keyring backend unavailable on get — treating as no secret");
            return Ok(None);
        }
        Err(e) => return Err(AppError::Secret(format!("open entry {key}: {e}"))),
    };
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(ref e) if is_backend_unavailable(e) => {
            tracing::warn!(key, error = %e, "keyring backend unavailable on get — treating as no secret");
            Ok(None)
        }
        Err(e) => Err(AppError::Secret(format!("get {key}: {e}"))),
    }
}

/// Returns whether a secret is currently stored. Used by the UI to show a
/// "stored" badge next to the password field when editing a session.
pub fn has(key: &str) -> Result<bool, AppError> {
    let entry = match open(key) {
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

/// Delete the stored secret. Treats "not present" OR "backend unavailable"
/// as success so callers can invoke this unconditionally during cleanup.
pub fn clear(key: &str) -> Result<(), AppError> {
    let entry = match open(key) {
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
