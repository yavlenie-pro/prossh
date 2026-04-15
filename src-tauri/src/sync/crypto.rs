//! Envelope encryption for the cloud-sync payload.
//!
//! This is conceptually the same recipe as [`crate::secrets::file_backend`]
//! but with a different magic header (`PROSSHSYNC01`) so a file lifted out
//! of one context can never be loaded into the other by accident. The
//! payload sitting on Google Drive is opaque binary — anyone who manages
//! to download it without the passphrase sees only random-looking bytes.
//!
//! Format (little-endian):
//!
//! ```text
//! offset  size    field
//! 0       12      magic       "PROSSHSYNC01"
//! 12      1       version     currently 1
//! 13      16      salt        random per-encryption (i.e. per-push)
//! 29      12      nonce       random per-encryption
//! 41      ...     ciphertext  AES-256-GCM over the JSON snapshot
//! ```
//!
//! A fresh salt on every encryption means two pushes of the same payload
//! produce different ciphertexts — that's intentional to avoid side-channel
//! confirmations of "nothing changed" by attackers watching Drive metadata.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::AppError;

const MAGIC: &[u8; 12] = b"PROSSHSYNC01";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const ARGON_MEM_KIB: u32 = 64 * 1024;
const ARGON_TIME: u32 = 3;
const ARGON_PAR: u32 = 1;

#[derive(Zeroize, ZeroizeOnDrop)]
struct DerivedKey([u8; KEY_LEN]);

fn derive(password: &str, salt: &[u8; SALT_LEN]) -> Result<DerivedKey, AppError> {
    let params = Params::new(ARGON_MEM_KIB, ARGON_TIME, ARGON_PAR, Some(KEY_LEN))
        .map_err(|e| AppError::Internal(format!("argon2 params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Internal(format!("argon2 derive: {e}")))?;
    Ok(DerivedKey(key))
}

/// Encrypt `plaintext` under `passphrase`. Returns the self-describing blob
/// that the frontend uploads to Drive verbatim.
pub fn encrypt(passphrase: &str, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    if passphrase.is_empty() {
        return Err(AppError::InvalidArgument(
            "sync passphrase must not be empty".into(),
        ));
    }
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);

    let key = derive(passphrase, &salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key.0));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|e| AppError::Internal(format!("aes-gcm encrypt: {e}")))?;

    let mut blob =
        Vec::with_capacity(MAGIC.len() + 1 + SALT_LEN + NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(MAGIC);
    blob.push(VERSION);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Decrypt a blob previously produced by [`encrypt`]. Wrong passphrase maps
/// to a generic "wrong passphrase or corrupt payload" error — we never
/// distinguish the two so attackers can't use error messages as an oracle.
pub fn decrypt(passphrase: &str, blob: &[u8]) -> Result<Vec<u8>, AppError> {
    let hdr = MAGIC.len() + 1 + SALT_LEN + NONCE_LEN;
    if blob.len() < hdr {
        return Err(AppError::Secret("sync payload is truncated".into()));
    }
    if &blob[..MAGIC.len()] != MAGIC {
        return Err(AppError::Secret(
            "sync payload has an unexpected header — is this file from ProSSH?".into(),
        ));
    }
    let version = blob[MAGIC.len()];
    if version != VERSION {
        return Err(AppError::Secret(format!(
            "unsupported sync payload version: {version}"
        )));
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&blob[MAGIC.len() + 1..MAGIC.len() + 1 + SALT_LEN]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(
        &blob[MAGIC.len() + 1 + SALT_LEN..MAGIC.len() + 1 + SALT_LEN + NONCE_LEN],
    );
    let ciphertext = &blob[hdr..];

    let key = derive(passphrase, &salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key.0));
    cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext)
        .map_err(|_| AppError::Secret("wrong passphrase or payload is corrupt".into()))
}
