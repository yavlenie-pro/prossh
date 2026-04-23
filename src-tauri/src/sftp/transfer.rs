//! Upload / download with progress reporting via `tauri::ipc::Channel`.
//! Supports cancellation via `CancellationToken`.
//!
//! Tuned for throughput:
//! - **Pipelined reads/writes**: up to 16 SFTP requests in flight at once.
//!   The high-level `russh_sftp::File` wrapper is sequential (AsyncRead state
//!   machine), which caps throughput at ~one chunk per RTT. We bypass it by
//!   using `RawSftpSession` directly on a dedicated SFTP subsystem channel.
//! - 248 KiB chunks (just under russh-sftp's MAX_READ_LENGTH of 255 KiB).
//! - `BufWriter` / `BufReader` on the local side to reduce syscalls.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::ssh::ProsshHandler;

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

/// 248 KiB — must stay ≤ 255 KiB (russh-sftp's MAX_READ_LENGTH = 261120).
/// Large chunks reduce SFTP round-trips; russh splits into 64 KiB SSH packets
/// automatically.
const CHUNK_SIZE: usize = 248 * 1024;
/// How many SFTP read/write requests to keep in flight simultaneously.
/// At 16 × 248 KiB ≈ 4 MiB in flight, well within the 32 MiB SSH window.
/// This is what lets us saturate links where RTT × bandwidth > chunk size.
const PIPELINE_DEPTH: usize = 16;
/// Local-side I/O buffer (4 MiB).
const LOCAL_BUF: usize = 4 * 1024 * 1024;
const PROGRESS_THROTTLE: std::time::Duration = std::time::Duration::from_millis(50);

/// Handle for a pipelined SFTP read task: returns `(offset, data, eof)`.
type ReadJoinHandle = tokio::task::JoinHandle<Result<(u64, Vec<u8>, bool), AppError>>;

/// Open a fresh SFTP subsystem on the given SSH connection and return a
/// `RawSftpSession`. Used for pipelined transfers — we need the raw API
/// because the high-level `File` wrapper can only have one read/write in
/// flight at a time.
async fn open_raw_sftp(
    handle: &russh::client::Handle<ProsshHandler>,
) -> Result<Arc<RawSftpSession>, AppError> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("channel_open_session: {e}")))?;
    channel
        .request_subsystem(false, "sftp")
        .await
        .map_err(|e| AppError::Ssh(format!("request_subsystem sftp: {e}")))?;

    let raw = RawSftpSession::new(channel.into_stream());
    raw.init()
        .await
        .map_err(|e| AppError::Ssh(format!("sftp init: {e}")))?;
    Ok(Arc::new(raw))
}

/// Upload a local file to the remote server using pipelined writes.
pub async fn upload(
    handle: &russh::client::Handle<ProsshHandler>,
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

    let raw = open_raw_sftp(handle).await?;
    let file_handle = raw
        .open(
            remote_path.to_string(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            FileAttributes::empty(),
        )
        .await
        .map_err(|e| AppError::Ssh(format!("create {remote_path}: {e}")))?
        .handle;

    // Pipeline: keep PIPELINE_DEPTH writes in flight.
    // We read sequentially from the local file and dispatch each chunk as a
    // concurrent SFTP WRITE request.
    let mut inflight: VecDeque<tokio::task::JoinHandle<Result<usize, AppError>>> =
        VecDeque::with_capacity(PIPELINE_DEPTH);
    let mut offset: u64 = 0;
    let mut bytes_sent: u64 = 0;
    let mut last_report = std::time::Instant::now();
    let mut eof = false;

    let close_and = |raw: Arc<RawSftpSession>, fh: String| async move {
        let _ = raw.close(fh).await;
    };

    loop {
        if cancel.is_cancelled() {
            // Drain in-flight writes before returning
            while let Some(h) = inflight.pop_front() {
                let _ = h.await;
            }
            close_and(raw.clone(), file_handle.clone()).await;
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

        // Top up the pipeline
        while !eof && inflight.len() < PIPELINE_DEPTH {
            let mut buf = vec![0u8; CHUNK_SIZE];
            let n = local_file
                .read(&mut buf)
                .await
                .map_err(|e| AppError::Io(format!("read local: {e}")))?;
            if n == 0 {
                eof = true;
                break;
            }
            buf.truncate(n);
            let write_offset = offset;
            offset += n as u64;

            let raw_cl = raw.clone();
            let fh = file_handle.clone();
            inflight.push_back(tokio::spawn(async move {
                raw_cl
                    .write(fh, write_offset, buf)
                    .await
                    .map_err(|e| AppError::Ssh(format!("write remote: {e}")))?;
                Ok(n)
            }));
        }

        // Drain the oldest completed write
        match inflight.pop_front() {
            Some(h) => {
                let n = h
                    .await
                    .map_err(|e| AppError::Internal(format!("join: {e}")))??;
                bytes_sent += n as u64;
            }
            None => break, // eof and pipeline drained
        }

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

    close_and(raw, file_handle).await;

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

/// Download a remote file using pipelined concurrent reads.
///
/// Throughput strategy: issue `PIPELINE_DEPTH` SFTP READ requests at
/// monotonically increasing offsets *before* the first response arrives.
/// Responses are collected in order and written sequentially to the local
/// file via a `BufWriter`. This turns a latency-bound sequential loop into a
/// bandwidth-bound streaming pipeline.
pub async fn download(
    handle: &russh::client::Handle<ProsshHandler>,
    remote_path: &str,
    local_path: &Path,
    total_size: u64,
    transfer_id: String,
    on_progress: &Channel<TransferProgress>,
    cancel: CancellationToken,
) -> Result<(), AppError> {
    let raw = open_raw_sftp(handle).await?;
    let file_handle = raw
        .open(
            remote_path.to_string(),
            OpenFlags::READ,
            FileAttributes::empty(),
        )
        .await
        .map_err(|e| AppError::Ssh(format!("open {remote_path}: {e}")))?
        .handle;

    let local_raw = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| AppError::Io(format!("create {}: {e}", local_path.display())))?;
    let mut local_file = BufWriter::with_capacity(LOCAL_BUF, local_raw);

    let mut inflight: VecDeque<ReadJoinHandle> = VecDeque::with_capacity(PIPELINE_DEPTH);
    let mut next_read_offset: u64 = 0;
    let mut bytes_recv: u64 = 0;
    let mut last_report = std::time::Instant::now();
    // `true` once the server has signalled EOF or we've queued all bytes.
    let mut done_queueing = false;

    let spawn_read =
        |raw: Arc<RawSftpSession>, fh: String, offset: u64, len: u32| {
            tokio::spawn(async move {
                use russh_sftp::client::error::Error;
                use russh_sftp::protocol::StatusCode;
                match raw.read(fh, offset, len).await {
                    Ok(data) => {
                        let n = data.data.len();
                        // Server may return fewer bytes than requested; treat
                        // a short read as EOF hint if it happens at end.
                        let is_short = (n as u32) < len;
                        Ok((offset, data.data, is_short && n == 0))
                    }
                    Err(Error::Status(s)) if s.status_code == StatusCode::Eof => {
                        Ok((offset, Vec::new(), true))
                    }
                    Err(e) => Err(AppError::Ssh(format!("read remote: {e}"))),
                }
            })
        };

    let cleanup = |raw: Arc<RawSftpSession>, fh: String| async move {
        let _ = raw.close(fh).await;
    };

    loop {
        if cancel.is_cancelled() {
            // Drain in-flight reads before cleaning up
            while let Some(h) = inflight.pop_front() {
                let _ = h.await;
            }
            cleanup(raw.clone(), file_handle.clone()).await;
            drop(local_file);
            let _ = tokio::fs::remove_file(local_path).await;
            let _ = on_progress.send(TransferProgress {
                transfer_id,
                bytes: bytes_recv,
                total: total_size,
                done: true,
                cancelled: true,
                error: None,
            });
            return Err(AppError::Internal("transfer cancelled".into()));
        }

        // Top up the pipeline with new reads
        while !done_queueing && inflight.len() < PIPELINE_DEPTH {
            let remaining = if total_size > 0 {
                total_size.saturating_sub(next_read_offset)
            } else {
                CHUNK_SIZE as u64 // keep reading; EOF from server stops us
            };
            if total_size > 0 && remaining == 0 {
                done_queueing = true;
                break;
            }
            let len = std::cmp::min(CHUNK_SIZE as u64, remaining) as u32;
            inflight.push_back(spawn_read(
                raw.clone(),
                file_handle.clone(),
                next_read_offset,
                len,
            ));
            next_read_offset += len as u64;
        }

        // Pop the oldest response and write to local file
        let Some(h) = inflight.pop_front() else {
            break; // nothing left in flight → done
        };
        let (_offset, data, server_eof) = h
            .await
            .map_err(|e| AppError::Internal(format!("join: {e}")))??;

        if !data.is_empty() {
            local_file
                .write_all(&data)
                .await
                .map_err(|e| AppError::Io(format!("write local: {e}")))?;
            bytes_recv += data.len() as u64;
        }
        if server_eof {
            // Drain remaining inflight (they should all return EOF too)
            while let Some(h) = inflight.pop_front() {
                if let Ok(Ok((_, more, _))) = h.await {
                    if !more.is_empty() {
                        local_file.write_all(&more).await.map_err(|e| {
                            AppError::Io(format!("write local: {e}"))
                        })?;
                        bytes_recv += more.len() as u64;
                    }
                }
            }
            break;
        }

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
    cleanup(raw, file_handle).await;

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

/// Copy a file directly between two remote servers (server-to-server),
/// streaming through the client in pipelined chunks. Reads from `src` are
/// parallelised via PIPELINE_DEPTH; writes to `dst` follow the same pattern.
#[allow(clippy::too_many_arguments)]
pub async fn server_copy(
    src_handle: &russh::client::Handle<ProsshHandler>,
    dst_handle: &russh::client::Handle<ProsshHandler>,
    src_path: &str,
    dst_path: &str,
    total_size: u64,
    transfer_id: String,
    on_progress: &Channel<TransferProgress>,
    cancel: CancellationToken,
) -> Result<(), AppError> {
    let src_raw = open_raw_sftp(src_handle).await?;
    let dst_raw = open_raw_sftp(dst_handle).await?;

    let src_fh = src_raw
        .open(
            src_path.to_string(),
            OpenFlags::READ,
            FileAttributes::empty(),
        )
        .await
        .map_err(|e| AppError::Ssh(format!("open source {src_path}: {e}")))?
        .handle;
    let dst_fh = dst_raw
        .open(
            dst_path.to_string(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            FileAttributes::empty(),
        )
        .await
        .map_err(|e| AppError::Ssh(format!("create dest {dst_path}: {e}")))?
        .handle;

    let mut read_inflight: VecDeque<ReadJoinHandle> = VecDeque::with_capacity(PIPELINE_DEPTH);
    let mut write_inflight: VecDeque<tokio::task::JoinHandle<Result<usize, AppError>>> =
        VecDeque::with_capacity(PIPELINE_DEPTH);
    let mut next_read_offset: u64 = 0;
    let mut bytes_copied: u64 = 0;
    let mut last_report = std::time::Instant::now();
    let mut done_reading = false;

    let spawn_read = |raw: Arc<RawSftpSession>, fh: String, offset: u64, len: u32| {
        tokio::spawn(async move {
            use russh_sftp::client::error::Error;
            use russh_sftp::protocol::StatusCode;
            match raw.read(fh, offset, len).await {
                Ok(data) => Ok((offset, data.data, false)),
                Err(Error::Status(s)) if s.status_code == StatusCode::Eof => {
                    Ok((offset, Vec::new(), true))
                }
                Err(e) => Err(AppError::Ssh(format!("read source: {e}"))),
            }
        })
    };

    loop {
        if cancel.is_cancelled() {
            while let Some(h) = read_inflight.pop_front() {
                let _ = h.await;
            }
            while let Some(h) = write_inflight.pop_front() {
                let _ = h.await;
            }
            let _ = src_raw.close(src_fh).await;
            let _ = dst_raw.close(dst_fh).await;
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

        // Top up source reads
        while !done_reading && read_inflight.len() < PIPELINE_DEPTH {
            let remaining = if total_size > 0 {
                total_size.saturating_sub(next_read_offset)
            } else {
                CHUNK_SIZE as u64
            };
            if total_size > 0 && remaining == 0 {
                done_reading = true;
                break;
            }
            let len = std::cmp::min(CHUNK_SIZE as u64, remaining) as u32;
            read_inflight.push_back(spawn_read(
                src_raw.clone(),
                src_fh.clone(),
                next_read_offset,
                len,
            ));
            next_read_offset += len as u64;
        }

        // Drain: for each completed read, launch a write; limit write concurrency.
        if let Some(rh) = read_inflight.pop_front() {
            let (offset, data, server_eof) = rh
                .await
                .map_err(|e| AppError::Internal(format!("join: {e}")))??;

            if !data.is_empty() {
                let raw_cl = dst_raw.clone();
                let fh_cl = dst_fh.clone();
                let n = data.len();
                let write_data = data;
                write_inflight.push_back(tokio::spawn(async move {
                    raw_cl
                        .write(fh_cl, offset, write_data)
                        .await
                        .map_err(|e| AppError::Ssh(format!("write dest: {e}")))?;
                    Ok(n)
                }));
            }
            if server_eof {
                done_reading = true;
            }
        } else if done_reading {
            // Nothing more to read — drain writes
            while let Some(wh) = write_inflight.pop_front() {
                let n = wh
                    .await
                    .map_err(|e| AppError::Internal(format!("join: {e}")))??;
                bytes_copied += n as u64;
            }
            break;
        }

        // Drain completed writes (non-blocking-ish: just one per outer iter)
        if write_inflight.len() >= PIPELINE_DEPTH {
            if let Some(wh) = write_inflight.pop_front() {
                let n = wh
                    .await
                    .map_err(|e| AppError::Internal(format!("join: {e}")))??;
                bytes_copied += n as u64;
            }
        }

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

    let _ = src_raw.close(src_fh).await;
    let _ = dst_raw.close(dst_fh).await;

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
