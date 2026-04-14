//! SFTP client — open, list, stat, mkdir, rmdir, remove, rename, chmod.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use serde::Serialize;

use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;
use crate::ssh::pty::Credential;
use crate::ssh::{HostKeyReport, ProsshHandler};
use crate::ssh::gate::PromptMap;

use super::SftpSession as AppSftpSession;

/// Metadata for a single remote file/directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

/// Open an SFTP session: TCP→SSH→auth→sftp subsystem.
#[allow(clippy::too_many_arguments)]
pub async fn open(
    known_hosts: Arc<KnownHostsStore>,
    passphrase_gate: PromptMap<String>,
    host_key_gate: PromptMap<bool>,
    host: String,
    port: u16,
    username: String,
    credential: Credential,
) -> Result<Arc<AppSftpSession>, AppError> {
    let runtime_id = uuid::Uuid::new_v4().to_string();
    let report = Arc::new(Mutex::new(None::<HostKeyReport>));

    let handler = ProsshHandler {
        host: host.clone(),
        port,
        known_hosts,
        report: report.clone(),
        host_key_gate: Some(host_key_gate),
        status_channel: None,
    };

    let config = Arc::new(russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 5,
        // Maximise throughput for file transfers:
        // - 16 MiB window keeps enough data "in flight" over high-latency links
        // - 256 KiB packets reduce per-packet overhead
        // - TCP_NODELAY avoids Nagle delays on small writes
        window_size: 32 * 1024 * 1024,        // 32 MiB — more in-flight data
        maximum_packet_size: 65535,            // SSH max
        channel_buffer_size: 1024,             // buffered unprocessed msgs (default 100)
        nodelay: true,
        ..Default::default()
    });

    let mut handle = russh::client::connect(config, (host.as_str(), port), handler)
        .await
        .map_err(|e| AppError::Ssh(format!("SFTP connect: {e}")))?;

    // --- Auth ---
    match credential {
        Credential::Password(password) => {
            let password = password.ok_or_else(|| {
                AppError::Ssh("no password stored for SFTP session".into())
            })?;
            let auth = handle
                .authenticate_password(&username, &password)
                .await
                .map_err(|e| AppError::Ssh(format!("auth: {e}")))?;
            if !auth.success() {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "auth failed", "en")
                    .await;
                return Err(AppError::Ssh("SFTP authentication failed".into()));
            }
        }
        Credential::Key { path, passphrase } => {
            use crate::ssh::auth::{load_private_key, KeyLoadResult, authenticate_publickey};

            let result = tokio::task::spawn_blocking({
                let p = path.clone();
                let pass = passphrase.clone();
                move || load_private_key(&p, pass.as_deref())
            })
            .await
            .map_err(|e| AppError::Internal(format!("join: {e}")))?;

            let loaded_key = match result? {
                KeyLoadResult::Loaded(k) => k,
                KeyLoadResult::NeedsPassphrase => {
                    // For SFTP we do a simpler passphrase flow — prompt once via gate
                    let (_prompt_id, rx) = crate::ssh::gate::register(&passphrase_gate).await;
                    // We don't have a status channel here, so the caller needs to handle this
                    // In practice, SFTP is opened after a terminal session already authenticated
                    let entered = rx.await.map_err(|_| {
                        AppError::Ssh("passphrase prompt cancelled".into())
                    })?;
                    if entered.is_empty() {
                        return Err(AppError::Ssh("passphrase cancelled".into()));
                    }
                    let p = path.clone();
                    let result2 = tokio::task::spawn_blocking(move || {
                        load_private_key(&p, Some(&entered))
                    })
                    .await
                    .map_err(|e| AppError::Internal(format!("join: {e}")))?;
                    match result2? {
                        KeyLoadResult::Loaded(k) => k,
                        KeyLoadResult::NeedsPassphrase => {
                            return Err(AppError::Ssh("wrong passphrase".into()));
                        }
                    }
                }
            };

            let ok = authenticate_publickey(&mut handle, &username, loaded_key).await?;
            if !ok {
                return Err(AppError::Ssh("SFTP public key auth rejected".into()));
            }
        }
    }

    // --- Open SFTP subsystem ---
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("sftp channel: {e}")))?;
    channel
        .request_subsystem(false, "sftp")
        .await
        .map_err(|e| AppError::Ssh(format!("request_subsystem sftp: {e}")))?;

    let sftp = SftpSession::new(channel.into_stream()).await
        .map_err(|e| AppError::Ssh(format!("sftp session init: {e}")))?;

    tracing::info!(
        runtime_id = %runtime_id, host = %host, port, username = %username,
        "sftp session opened"
    );

    Ok(Arc::new(AppSftpSession {
        runtime_id: runtime_id.clone(),
        session_id: String::new(),
        sftp,
        handle,
    }))
}

/// List entries in a remote directory.
pub async fn list_dir(sftp: &SftpSession, path: &str) -> Result<Vec<RemoteEntry>, AppError> {
    let dir = sftp.read_dir(path).await
        .map_err(|e| AppError::Ssh(format!("read_dir({path}): {e}")))?;

    let mut entries = Vec::new();
    for item in dir {
        let name = item.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let file_path = if path == "/" {
            format!("/{name}")
        } else {
            format!("{path}/{name}")
        };
        let attrs = item.metadata();
        let is_dir = attrs.is_dir();
        let size = attrs.size.unwrap_or(0);
        let modified = attrs.mtime.map(|v| v as u64);
        let permissions = attrs.permissions;
        let uid = attrs.uid;
        let gid = attrs.gid;
        let owner = attrs.user.clone();
        let group = attrs.group.clone();

        entries.push(RemoteEntry {
            name,
            path: file_path,
            is_dir,
            size,
            modified,
            permissions,
            uid,
            gid,
            owner,
            group,
        });
    }

    // Sort: dirs first, then by name
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
        })
    });

    Ok(entries)
}

/// Create a remote directory.
pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    sftp.create_dir(path).await
        .map_err(|e| AppError::Ssh(format!("mkdir({path}): {e}")))
}

/// Remove a remote file.
pub async fn remove(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    sftp.remove_file(path).await
        .map_err(|e| AppError::Ssh(format!("remove({path}): {e}")))
}

/// Recursively remove a remote directory and all its contents.
/// If the path is a symlink (read_dir fails), falls back to remove_file.
pub async fn rmdir(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    match list_dir(sftp, path).await {
        Ok(entries) => {
            for entry in entries {
                if entry.is_dir {
                    Box::pin(rmdir(sftp, &entry.path)).await?;
                } else {
                    remove(sftp, &entry.path).await?;
                }
            }
            sftp.remove_dir(path).await
                .map_err(|e| AppError::Ssh(format!("rmdir({path}): {e}")))
        }
        Err(_) => {
            // read_dir failed — likely a symlink or inaccessible dir.
            // Try remove as file (covers symlinks), then remove_dir as fallback.
            if sftp.remove_file(path).await.is_ok() {
                return Ok(());
            }
            sftp.remove_dir(path).await
                .map_err(|e| AppError::Ssh(format!("rmdir({path}): {e}")))
        }
    }
}

/// Create an empty remote file (touch).
pub async fn touch(sftp: &SftpSession, path: &str) -> Result<(), AppError> {
    use russh_sftp::protocol::OpenFlags;
    let file = sftp.open_with_flags(path, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE)
        .await
        .map_err(|e| AppError::Ssh(format!("touch({path}): {e}")))?;
    // Drop the file handle to close it
    drop(file);
    Ok(())
}

/// Rename / move a remote path.
pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<(), AppError> {
    sftp.rename(from, to).await
        .map_err(|e| AppError::Ssh(format!("rename({from} -> {to}): {e}")))
}
