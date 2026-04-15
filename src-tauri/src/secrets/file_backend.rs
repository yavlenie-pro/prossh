//! File-based encrypted secret vault.
//!
//! This is the fallback for environments where the OS keyring isn't
//! available (headless Linux boxes without a DBus session bus, CI machines,
//! Arch without gnome-keyring, tester laptops without Credential Manager
//! access, …). The user picks a master password and we store all session
//! secrets in a single file at `<data_dir>/prossh/secrets.vault`, encrypted
//! with AES-256-GCM using a key derived from the password via Argon2id.
//!
//! ## File format (little-endian binary blob)
//!
//! ```text
//! offset  size    field
//! 0       8       magic       "PROSSH01"
//! 8       1       version     current = 1
//! 9       16      salt        random per-vault, reused on every save
//! 25      12      nonce       fresh random on every save
//! 37      ...     ciphertext  AES-256-GCM over JSON(HashMap<String, String>)
//! ```
//!
//! Salt stays constant for the lifetime of the vault so that unlocking
//! with the same password produces the same derived key — changing the
//! password rewrites the whole file with a new salt. The GCM nonce is
//! regenerated on every save to keep (key, nonce) pairs unique.
//!
//! ## Threat model
//!
//! - Protects secrets-at-rest against anyone who gains read access to the
//!   file without the master password.
//! - Does **not** protect against a live attacker on the same machine while
//!   the vault is unlocked — the derived key sits in process memory.
//! - `zeroize` is applied to the key buffer on drop to minimise window of
//!   exposure, but Rust's move semantics mean this is best-effort.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::AppError;

const MAGIC: &[u8; 8] = b"PROSSH01";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// Argon2id parameters — chosen to keep unlock under ~250ms on a typical
/// laptop. We lean on memory hardness (64 MiB) rather than iteration count.
const ARGON_MEM_KIB: u32 = 64 * 1024;
const ARGON_TIME: u32 = 3;
const ARGON_PARALLELISM: u32 = 1;

/// Zeroizing wrapper around the 32-byte AES key so that dropping the vault
/// (or re-locking it) scrubs the key from memory.
#[derive(Zeroize, ZeroizeOnDrop, Clone)]
struct VaultKey([u8; KEY_LEN]);

/// State held in memory while the vault is unlocked.
struct UnlockedState {
    key: VaultKey,
    salt: [u8; SALT_LEN],
    entries: HashMap<String, String>,
}

pub struct FileBackend {
    path: PathBuf,
    unlocked: Option<UnlockedState>,
}

impl FileBackend {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            unlocked: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True iff the vault file exists on disk.
    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// True iff the vault has been unlocked in this process.
    pub fn is_unlocked(&self) -> bool {
        self.unlocked.is_some()
    }

    /// Create a brand-new vault, overwriting any existing file. The vault is
    /// left in the unlocked state after creation so the caller can
    /// immediately start storing secrets.
    pub fn create(&mut self, password: &str) -> Result<(), AppError> {
        if password.is_empty() {
            return Err(AppError::Secret("master password must not be empty".into()));
        }
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let key = derive_key(password, &salt)?;
        let state = UnlockedState {
            key,
            salt,
            entries: HashMap::new(),
        };
        persist(&self.path, &state)?;
        self.unlocked = Some(state);
        tracing::info!(path = %self.path.display(), "encrypted vault created");
        Ok(())
    }

    /// Try to decrypt the vault with `password`. Returns an `AppError::Secret`
    /// with a clear message on wrong password / missing file.
    pub fn unlock(&mut self, password: &str) -> Result<(), AppError> {
        if !self.path.exists() {
            return Err(AppError::Secret(
                "encrypted vault does not exist yet — create one first".into(),
            ));
        }
        let blob = fs::read(&self.path)
            .map_err(|e| AppError::Secret(format!("read vault: {e}")))?;
        let parts = parse_blob(&blob)?;
        let key = derive_key(password, &parts.salt)?;
        let plaintext = decrypt(&key, &parts.nonce, parts.ciphertext).map_err(|_| {
            AppError::Secret("wrong master password or vault is corrupt".into())
        })?;
        let entries: HashMap<String, String> = serde_json::from_slice(&plaintext)
            .map_err(|e| AppError::Secret(format!("vault payload is malformed: {e}")))?;
        self.unlocked = Some(UnlockedState {
            key,
            salt: parts.salt,
            entries,
        });
        tracing::info!(path = %self.path.display(), "encrypted vault unlocked");
        Ok(())
    }

    /// Drop the in-memory key and entries. Subsequent reads / writes fail
    /// until the user unlocks again.
    pub fn lock(&mut self) {
        if self.unlocked.take().is_some() {
            tracing::info!("encrypted vault locked");
        }
    }

    /// Change the master password. Requires the vault to be already unlocked
    /// (or valid `old` password to unlock it). Writes a new file with a
    /// freshly generated salt.
    pub fn change_password(&mut self, old: &str, new: &str) -> Result<(), AppError> {
        if new.is_empty() {
            return Err(AppError::Secret("new master password must not be empty".into()));
        }
        // Verify the old password regardless of whether we're currently
        // unlocked — prevents hijacking an already-open session to set a
        // new password without knowing the current one.
        let blob = fs::read(&self.path)
            .map_err(|e| AppError::Secret(format!("read vault: {e}")))?;
        let parts = parse_blob(&blob)?;
        let old_key = derive_key(old, &parts.salt)?;
        if decrypt(&old_key, &parts.nonce, parts.ciphertext).is_err() {
            return Err(AppError::Secret("current master password is wrong".into()));
        }
        // Reuse the already-decrypted entries if we have them, otherwise
        // decrypt again with old key (we just validated).
        let entries = if let Some(ref s) = self.unlocked {
            s.entries.clone()
        } else {
            let plain = decrypt(&old_key, &parts.nonce, parts.ciphertext)
                .map_err(|_| AppError::Secret("vault decrypt failed".into()))?;
            serde_json::from_slice(&plain)
                .map_err(|e| AppError::Secret(format!("vault payload: {e}")))?
        };
        let mut new_salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut new_salt);
        let new_key = derive_key(new, &new_salt)?;
        let state = UnlockedState {
            key: new_key,
            salt: new_salt,
            entries,
        };
        persist(&self.path, &state)?;
        self.unlocked = Some(state);
        tracing::info!("encrypted vault password changed");
        Ok(())
    }

    pub fn set(&mut self, key: &str, secret: &str) -> Result<(), AppError> {
        let state = self
            .unlocked
            .as_mut()
            .ok_or_else(|| AppError::Secret("vault is locked".into()))?;
        state.entries.insert(key.to_string(), secret.to_string());
        persist(&self.path, state)
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, AppError> {
        let state = self
            .unlocked
            .as_ref()
            .ok_or_else(|| AppError::Secret("vault is locked".into()))?;
        Ok(state.entries.get(key).cloned())
    }

    pub fn has(&self, key: &str) -> Result<bool, AppError> {
        let state = self
            .unlocked
            .as_ref()
            .ok_or_else(|| AppError::Secret("vault is locked".into()))?;
        Ok(state.entries.contains_key(key))
    }

    pub fn clear(&mut self, key: &str) -> Result<(), AppError> {
        let state = self
            .unlocked
            .as_mut()
            .ok_or_else(|| AppError::Secret("vault is locked".into()))?;
        if state.entries.remove(key).is_some() {
            persist(&self.path, state)?;
        }
        Ok(())
    }

    /// Delete the vault file entirely and forget any cached state.
    /// Returns Ok even if the file was already missing.
    pub fn destroy(&mut self) -> Result<(), AppError> {
        self.unlocked = None;
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::Secret(format!("remove vault: {e}"))),
        }
    }
}

// ---- helpers ----

struct ParsedBlob<'a> {
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
    ciphertext: &'a [u8],
}

fn parse_blob(blob: &[u8]) -> Result<ParsedBlob<'_>, AppError> {
    let hdr_len = MAGIC.len() + 1 + SALT_LEN + NONCE_LEN;
    if blob.len() < hdr_len {
        return Err(AppError::Secret("vault file is truncated".into()));
    }
    if &blob[..MAGIC.len()] != MAGIC {
        return Err(AppError::Secret("vault file has wrong magic header".into()));
    }
    let version = blob[MAGIC.len()];
    if version != VERSION {
        return Err(AppError::Secret(format!(
            "unsupported vault version: {version} (this build expects {VERSION})"
        )));
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&blob[MAGIC.len() + 1..MAGIC.len() + 1 + SALT_LEN]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(
        &blob[MAGIC.len() + 1 + SALT_LEN..MAGIC.len() + 1 + SALT_LEN + NONCE_LEN],
    );
    let ciphertext = &blob[hdr_len..];
    Ok(ParsedBlob {
        salt,
        nonce,
        ciphertext,
    })
}

fn derive_key(password: &str, salt: &[u8; SALT_LEN]) -> Result<VaultKey, AppError> {
    let params = Params::new(ARGON_MEM_KIB, ARGON_TIME, ARGON_PARALLELISM, Some(KEY_LEN))
        .map_err(|e| AppError::Secret(format!("argon2 params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| AppError::Secret(format!("argon2 derive: {e}")))?;
    Ok(VaultKey(out))
}

fn encrypt(
    key: &VaultKey,
    nonce_bytes: &[u8; NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, AppError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key.0));
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::Secret(format!("aes-gcm encrypt: {e}")))
}

fn decrypt(
    key: &VaultKey,
    nonce_bytes: &[u8; NONCE_LEN],
    ciphertext: &[u8],
) -> Result<Vec<u8>, AppError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key.0));
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| AppError::Secret(format!("aes-gcm decrypt: {e}")))
}

/// Re-serialise + re-encrypt the vault and atomically swap the file.
fn persist(path: &Path, state: &UnlockedState) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Secret(format!("create vault dir: {e}")))?;
    }

    let payload = serde_json::to_vec(&state.entries)
        .map_err(|e| AppError::Secret(format!("serialize entries: {e}")))?;

    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = encrypt(&state.key, &nonce, &payload)?;

    let mut blob =
        Vec::with_capacity(MAGIC.len() + 1 + SALT_LEN + NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(MAGIC);
    blob.push(VERSION);
    blob.extend_from_slice(&state.salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);

    // Atomic replace: write to `<path>.tmp`, fsync, rename.
    let tmp_path = path.with_extension("vault.tmp");
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|e| AppError::Secret(format!("open tmp vault: {e}")))?;
        f.write_all(&blob)
            .map_err(|e| AppError::Secret(format!("write tmp vault: {e}")))?;
        f.sync_all()
            .map_err(|e| AppError::Secret(format!("fsync tmp vault: {e}")))?;
    }
    fs::rename(&tmp_path, path)
        .map_err(|e| AppError::Secret(format!("swap vault: {e}")))?;

    // Best-effort scrub of the temp plaintext buffer.
    let mut payload = payload;
    payload.zeroize();
    Ok(())
}

