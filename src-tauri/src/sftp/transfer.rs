//! Upload / download with progress reporting via `tauri::ipc::Channel`.
//! Supports cancellation via `CancellationToken`.
//!
//! Tuned for throughput:
//! - 256 KiB read/write chunks (matches SSH maximum_packet_size)
//! - `BufWriter` / `BufReader` on the local side to reduce syscalls

use std::path::Path;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;

/// Progress event streamed to the frontend during transfers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    /// Unique id for this transfer (so the UI can track multiple).
    pub transfer_id: String,
    /// Bytes transferred so far.
    pub bytes: u64,
    /// Total size in bytes (may be 0 if unknown).
    pub total: u64,
    /// True when the transfer is complete.
    pub done: bool,
    /// True if the transfer was cancelled.
    pub cancelled: bool,
    /// Non-empty if the transfer failed.
    pub error: Option<String>,
}

/// 256 KiB — larger chunks reduce SFTP round-trips.
/// russh-sftp splits into SSH packets internally; the big win comes from
/// the large window_size which allows many packets in flight simultaneously.
const CHUNK_SIZE: usize = 256 * 1024;
/// Local-side I/O buffer (4 MiB).
const LOCAL_BUF: usize = 4 * 1024 * 1024;
const PROGRESS_THROTTLE: std::time::Duration = std::time::Duration::from_millis(50);

/// Upload a local file to the remote server.
pub async fn upload(
    sftp: &russh_sftp::client::SftpSession,
    local_path: &Path,
    remote_path: &str,
    transfer_id: String,
    on_progress: &Channel<TransferProgress>,
    cancel: CancellationToken,
) -> Result<(), AppError> {
    let meta = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| AppError::Io(format!("stat {}: {e}", local_path.display())))?;
    let total = meta.len();

    let local_raw = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| AppError::Io(format!("open {}: {e}", local_path.display())))?;
    let mut local_file = BufReader::with_capacity(LOCAL_BUF, local_raw);

    let mut remote_file = sftp
        .create(remote_path)
        .await
        .map_err(|e| AppError::Ssh(format!("create {remote_path}: {e}")))?;

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut bytes_sent: u64 = 0;
    let mut last_report = std::time::Instant::now();

    loop {
        if cancel.is_cancelled() {
            let _ = on_progress.send(TransferProgress {
                transfer_id,
                bytes: bytes_sent,
                total,
                done: true,
                cancelled: true,
                error: None,
            });
            return Err(AppError::Internal("transfer cancelled".into()));
        }

        let n = local_file
            .read(&mut buf)
            .await
            .map_err(|e| AppError::Io(format!("read local: {e}")))?;
        if n == 0 {
            break;
        }
        remote_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| AppError::Ssh(format!("write remote: {e}")))?;
        bytes_sent += n as u64;

        if last_report.elapsed() >= PROGRESS_THROTTLE {
            let _ = on_progress.send(TransferProgress {
                transfer_id: transfer_id.clone(),
                bytes: bytes_sent,
                total,
                done: false,
                cancelled: false,
                error: None,
            });
            last_report = std::time::Instant::now();
        }
    }

    remote_file
        .shutdown()
        .await
        .map_err(|e| AppError::Ssh(format!("flush remote: {e}")))?;

    let _ = on_progress.send(TransferProgress {
        transfer_id,
        bytes: bytes_sent,
        total,
        done: true,
        cancelled: false,
        error: None,
    });

    Ok(())
}

/// Download a remote file to the local filesystem.
pub async fn download(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    local_path: &Path,
    total_size: u64,
    transfer_id: String,
    on_progress: &Channel<TransferProgress>,
    cancel: CancellationToken,
) -> Result<(), AppError> {
    let mut remote_file = sftp
        .open(remote_path)
        .await
        .map_err(|e| AppError::Ssh(format!("open {remote_path}: {e}")))?;

    let local_raw = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| AppError::Io(format!("create {}: {e}", local_path.display())))?;
    let mut local_file = BufWriter::with_capacity(LOCAL_BUF, local_raw);

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut bytes_recv: u64 = 0;
    let mut last_report = std::time::Instant::now();

    loop {
        if cancel.is_cancelled() {
            let _ = on_progress.send(TransferProgress {
                transfer_id,
                bytes: bytes_recv,
                total: total_size,
                done: true,
                cancelled: true,
                error: None,
            });
            // Clean up partial file
            drop(local_file);
            let _ = tokio::fs::remove_file(local_path).await;
            return Err(AppError::Internal("transfer cancelled".into()));
        }

        let n = remote_file
            .read(&mut buf)
            .await
            .map_err(|e| AppError::Ssh(format!("read remote: {e}")))?;
        if n == 0 {
            break;
        }
        local_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| AppError::Io(format!("write local: {e}")))?;
        bytes_recv += n as u64;

        if last_report.elapsed() >= PROGRESS_THROTTLE {
            let _ = on_progress.send(TransferProgress {
                transfer_id: transfer_id.clone(),
                bytes: bytes_recv,
                total: total_size,
                done: false,
                cancelled: false,
                error: None,
            });
            last_report = std::time::Instant::now();
        }
    }

    local_file
        .flush()
        .await
        .map_err(|e| AppError::Io(format!("flush local: {e}")))?;

    let _ = on_progress.send(TransferProgress {
        transfer_id,
        bytes: bytes_recv,
        total: total_size,
        done: true,
        cancelled: false,
        error: None,
    });

    Ok(())
}

/// Copy a file directly between two remote servers (server-to-server).
/// Reads from `src_sftp` and writes to `dst_sftp` without touching the local
/// filesystem, streaming data through the client in 64 KiB chunks.
pub async fn server_copy(
    src_sftp: &russh_sftp::client::SftpSession,
    dst_sftp: &russh_sftp::client::SftpSession,
    src_path: &str,
    dst_path: &str,
    total_size: u64,
    transfer_id: String,
    on_progress: &Channel<TransferProgress>,
    cancel: CancellationToken,
) -> Result<(), AppError> {
    let mut src_file = src_sftp
        .open(src_path)
        .await
        .map_err(|e| AppError::Ssh(format!("open source {src_path}: {e}")))?;

    let mut dst_file = dst_sftp
        .create(dst_path)
        .await
        .map_err(|e| AppError::Ssh(format!("create dest {dst_path}: {e}")))?;

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut bytes_copied: u64 = 0;
    let mut last_report = std::time::Instant::now();

    loop {
        if cancel.is_cancelled() {
            let _ = on_progress.send(TransferProgress {
                transfer_id,
                bytes: bytes_copied,
                total: total_size,
                done: true,
                cancelled: true,
                error: None,
            });
            return Err(AppError::Internal("transfer cancelled".into()));
        }

        let n = src_file
            .read(&mut buf)
            .await
            .map_err(|e| AppError::Ssh(format!("read source: {e}")))?;
        if n == 0 {
            break;
        }
        dst_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| AppError::Ssh(format!("write dest: {e}")))?;
        bytes_copied += n as u64;

        if last_report.elapsed() >= PROGRESS_THROTTLE {
            let _ = on_progress.send(TransferProgress {
                transfer_id: transfer_id.clone(),
                bytes: bytes_copied,
                total: total_size,
                done: false,
                cancelled: false,
                error: None,
            });
            last_report = std::time::Instant::now();
        }
    }

    dst_file
        .shutdown()
        .await
        .map_err(|e| AppError::Ssh(format!("flush dest: {e}")))?;

    let _ = on_progress.send(TransferProgress {
        transfer_id,
        bytes: bytes_copied,
        total: total_size,
        done: true,
        cancelled: false,
        error: None,
    });

    Ok(())
}
