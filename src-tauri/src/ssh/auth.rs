//! Authentication helpers — password and public-key.
//!
//! Public-key auth loads the private key from disk via `russh::keys::load_secret_key`.
//! If the key is encrypted and no passphrase is available, the caller should
//! prompt the user and retry.

use std::path::Path;
use std::sync::Arc;

use crate::error::AppError;

/// Result of attempting to load a private key from a file.
pub enum KeyLoadResult {
    /// Key loaded and ready for `authenticate_publickey`.
    Loaded(russh::keys::key::PrivateKeyWithHashAlg),
    /// The key file is encrypted and needs a passphrase.
    NeedsPassphrase,
}

/// Try to load a private key from `path`. If `passphrase` is `None` and the key
/// is encrypted, returns [`KeyLoadResult::NeedsPassphrase`] instead of an error.
pub fn load_private_key(
    path: &Path,
    passphrase: Option<&str>,
) -> Result<KeyLoadResult, AppError> {
    match russh::keys::load_secret_key(path, passphrase) {
        Ok(key) => {
            // For RSA keys, `None` maps to legacy SHA-1 (ssh-rsa) which most
            // modern servers reject. Use SHA-256 (rsa-sha2-256) instead.
            // For Ed25519/ECDSA the hash_alg is ignored by russh.
            let hash_alg = if key.algorithm().is_rsa() {
                Some(russh::keys::HashAlg::Sha256)
            } else {
                None
            };
            Ok(KeyLoadResult::Loaded(
                russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            ))
        }
        Err(e) => {
            let msg = e.to_string().to_lowercase();
            // russh returns various error strings for encrypted keys w/o passphrase.
            if passphrase.is_none()
                && (msg.contains("encrypted")
                    || msg.contains("passphrase")
                    || msg.contains("decrypt")
                    || msg.contains("password"))
            {
                Ok(KeyLoadResult::NeedsPassphrase)
            } else {
                Err(AppError::Ssh(format!("load key {}: {e}", path.display())))
            }
        }
    }
}

/// Authenticate with a public key. Returns `true` on success.
pub async fn authenticate_publickey(
    handle: &mut russh::client::Handle<super::ProsshHandler>,
    username: &str,
    key: russh::keys::key::PrivateKeyWithHashAlg,
) -> Result<bool, AppError> {
    let auth = handle
        .authenticate_publickey(username, key)
        .await
        .map_err(|e| AppError::Ssh(format!("authenticate_publickey: {e}")))?;
    Ok(auth.success())
}
