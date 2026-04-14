//! SFTP module — connect, browse, transfer files over an SSH channel.
//!
//! Architecture:
//! - [`SftpSession`] wraps a `russh_sftp::client::SftpSession` + the underlying
//!   `russh::client::Handle` so we can disconnect cleanly.
//! - [`transfer`] provides upload/download with progress streaming.
//!
//! Each active SFTP tab maps to one `SftpSession` keyed by a UUID `runtime_id`.

pub mod client;
pub mod transfer;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::ssh::ProsshHandler;

/// A live SFTP session.
pub struct SftpSession {
    pub runtime_id: String,
    pub session_id: String,
    pub sftp: russh_sftp::client::SftpSession,
    pub handle: russh::client::Handle<ProsshHandler>,
}

pub type SftpMap = Arc<RwLock<HashMap<String, Arc<SftpSession>>>>;

pub fn new_sftp_map() -> SftpMap {
    Arc::new(RwLock::new(HashMap::new()))
}
