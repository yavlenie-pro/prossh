//! Tauri IPC commands for SFTP operations.

use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::secrets;
use crate::sessions::{repo, secret_key, AuthMethod};
use crate::sftp::client::{self, RemoteEntry};
use crate::sftp::transfer::{self, TransferProgress};
use crate::ssh::pty::Credential;
use crate::state::AppState;

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Internal(format!("blocking join failed: {e}"))
}

/// Open a new SFTP session. Returns the `runtime_id`.
#[tauri::command]
pub async fn sftp_open(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, AppError> {
    // 1. Load session
    let conn = state.db.conn.clone();
    let sid = session_id.clone();
    let session = tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::fetch_session(&conn, &sid)
    })
    .await
    .map_err(join_err)??;

    // 2. Build credential
    let credential = match session.auth_method {
        AuthMethod::Password => {
            let key = secret_key(&session.id);
            let password = tokio::task::spawn_blocking(move || secrets::get(&key))
                .await
                .map_err(join_err)??
                .ok_or_else(|| AppError::Ssh("no password stored".into()))?;
            Credential::Password(Some(password))
        }
        AuthMethod::Key => {
            let key_path = session
                .private_key_path
                .as_deref()
                .ok_or_else(|| AppError::Ssh("no private key path configured".into()))?
                .into();
            let secret_k = secret_key(&session.id);
            let passphrase = tokio::task::spawn_blocking(move || secrets::get(&secret_k))
                .await
                .map_err(join_err)??;
            Credential::Key {
                path: key_path,
                passphrase,
            }
        }
        AuthMethod::Agent => {
            return Err(AppError::Ssh("SSH agent auth not yet supported for SFTP".into()));
        }
    };

    // 3. Open SFTP
    let sftp_session = client::open(
        state.known_hosts.clone(),
        state.passphrase_gate.clone(),
        state.host_key_gate.clone(),
        session.host.clone(),
        session.port,
        session.username.clone(),
        credential,
    )
    .await?;

    let runtime_id = sftp_session.runtime_id.clone();

    {
        let mut map = state.sftp_sessions.write().await;
        map.insert(runtime_id.clone(), sftp_session);
    }

    Ok(runtime_id)
}

/// Close an SFTP session.
#[tauri::command]
pub async fn sftp_close(
    state: State<'_, AppState>,
    runtime_id: String,
) -> Result<(), AppError> {
    let session = {
        let mut map = state.sftp_sessions.write().await;
        map.remove(&runtime_id)
    };
    if let Some(sess) = session {
        let _ = sess
            .handle
            .disconnect(russh::Disconnect::ByApplication, "sftp closed", "en")
            .await;
        tracing::info!(runtime_id = %runtime_id, "sftp session closed");
    }
    Ok(())
}

/// List directory entries.
#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    runtime_id: String,
    path: String,
) -> Result<Vec<RemoteEntry>, AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    client::list_dir(&sess.sftp, &path).await
}

/// Create a remote directory.
#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    runtime_id: String,
    path: String,
) -> Result<(), AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    client::mkdir(&sess.sftp, &path).await
}

/// Remove a remote directory (recursively via `rm -rf` over SSH exec).
#[tauri::command]
pub async fn sftp_rmdir(
    state: State<'_, AppState>,
    runtime_id: String,
    path: String,
) -> Result<(), AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    // Shell-escape single quotes in path
    let escaped = path.replace('\'', "'\\''");
    let cmd = format!("rm -rf '{escaped}'");
    let mut ch = sess.handle.channel_open_session().await
        .map_err(|e| AppError::Ssh(format!("channel_open_session: {e}")))?;
    ch.exec(true, cmd.as_bytes()).await
        .map_err(|e| AppError::Ssh(format!("exec rm -rf: {e}")))?;
    let mut stderr_buf = Vec::new();
    let mut exit_code: Option<u32> = None;
    while let Some(msg) = ch.wait().await {
        match msg {
            russh::ChannelMsg::ExtendedData { ref data, .. } => stderr_buf.extend_from_slice(data),
            russh::ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    if exit_code.unwrap_or(0) != 0 && !stderr_buf.is_empty() {
        let msg = String::from_utf8_lossy(&stderr_buf);
        return Err(AppError::Ssh(format!("rm -rf '{}': {}", path, msg.trim())));
    }
    Ok(())
}

/// Remove a remote file.
#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    runtime_id: String,
    path: String,
) -> Result<(), AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    client::remove(&sess.sftp, &path).await
}

/// Create an empty remote file.
#[tauri::command]
pub async fn sftp_touch(
    state: State<'_, AppState>,
    runtime_id: String,
    path: String,
) -> Result<(), AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    client::touch(&sess.sftp, &path).await
}

/// Rename / move a remote file or directory.
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    runtime_id: String,
    from: String,
    to: String,
) -> Result<(), AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    client::rename(&sess.sftp, &from, &to).await
}

/// Upload a local file to the remote server (with cancellation support).
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    runtime_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    on_progress: Channel<TransferProgress>,
) -> Result<(), AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    let cancel = CancellationToken::new();
    {
        let mut map = state.transfer_cancellations.write().await;
        map.insert(transfer_id.clone(), cancel.clone());
    }
    let result = transfer::upload(
        &sess.handle,
        std::path::Path::new(&local_path),
        &remote_path,
        transfer_id.clone(),
        &on_progress,
        cancel,
    )
    .await;
    // Clean up token
    {
        let mut map = state.transfer_cancellations.write().await;
        map.remove(&transfer_id);
    }
    result
}

/// Download a remote file to the local filesystem (with cancellation support).
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    runtime_id: String,
    remote_path: String,
    local_path: String,
    total_size: u64,
    transfer_id: String,
    on_progress: Channel<TransferProgress>,
) -> Result<(), AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    let cancel = CancellationToken::new();
    {
        let mut map = state.transfer_cancellations.write().await;
        map.insert(transfer_id.clone(), cancel.clone());
    }
    let result = transfer::download(
        &sess.handle,
        &remote_path,
        std::path::Path::new(&local_path),
        total_size,
        transfer_id.clone(),
        &on_progress,
        cancel,
    )
    .await;
    {
        let mut map = state.transfer_cancellations.write().await;
        map.remove(&transfer_id);
    }
    result
}

/// Copy a file directly between two remote servers via SFTP.
/// Both sessions must already be open (via `sftp_open`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_server_copy(
    state: State<'_, AppState>,
    src_runtime_id: String,
    src_path: String,
    dst_runtime_id: String,
    dst_path: String,
    total_size: u64,
    transfer_id: String,
    on_progress: Channel<TransferProgress>,
) -> Result<(), AppError> {
    let src_sess = get_session(&state, &src_runtime_id).await?;
    let dst_sess = get_session(&state, &dst_runtime_id).await?;
    let cancel = CancellationToken::new();
    {
        let mut map = state.transfer_cancellations.write().await;
        map.insert(transfer_id.clone(), cancel.clone());
    }
    let result = transfer::server_copy(
        &src_sess.handle,
        &dst_sess.handle,
        &src_path,
        &dst_path,
        total_size,
        transfer_id.clone(),
        &on_progress,
        cancel,
    )
    .await;
    {
        let mut map = state.transfer_cancellations.write().await;
        map.remove(&transfer_id);
    }
    result
}

/// Result of executing a command on a remote server.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

/// Execute a command on a remote server using the SFTP session's SSH handle.
/// This opens a new exec channel on the existing connection — no new auth needed.
#[tauri::command]
pub async fn ssh_remote_exec(
    state: State<'_, AppState>,
    runtime_id: String,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<ExecResult, AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(30));

    let mut channel = sess
        .handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("channel_open_session: {e}")))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

    let mut stdout: Vec<u8> = Vec::with_capacity(4096);
    let mut stderr: Vec<u8> = Vec::with_capacity(1024);
    let mut exit_code: Option<u32> = None;
    let mut got_eof = false;

    loop {
        match tokio::time::timeout(timeout, channel.wait()).await {
            Ok(Some(msg)) => match msg {
                russh::ChannelMsg::Data { ref data } => {
                    stdout.extend_from_slice(&data[..]);
                }
                russh::ChannelMsg::ExtendedData { ref data, ext: _ } => {
                    stderr.extend_from_slice(&data[..]);
                }
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = Some(exit_status);
                    if got_eof { break; }
                }
                russh::ChannelMsg::Eof => {
                    got_eof = true;
                    // Don't break yet — ExitStatus often arrives after Eof
                    if exit_code.is_some() { break; }
                }
                russh::ChannelMsg::Close => break,
                _ => {}
            },
            Ok(None) => break,
            Err(_) => {
                return Err(AppError::Ssh(format!(
                    "command did not finish within {timeout_secs:?}s"
                )));
            }
        }
    }

    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
    })
}

/// Chunk streamed to the frontend during a long-running exec command.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecChunk {
    /// stdout text received in this chunk.
    pub stdout: String,
    /// stderr text received in this chunk.
    pub stderr: String,
    /// Set when the command finishes.
    pub exit_code: Option<u32>,
    /// True when the command has finished (final chunk).
    pub done: bool,
}

/// Execute a command on a remote server, streaming stdout/stderr chunks
/// to the frontend in real-time via a Tauri Channel.
/// Used for rsync/scp progress reporting.
#[tauri::command]
pub async fn ssh_remote_exec_stream(
    state: State<'_, AppState>,
    runtime_id: String,
    command: String,
    transfer_id: Option<String>,
    timeout_secs: Option<u64>,
    on_output: tauri::ipc::Channel<ExecChunk>,
) -> Result<ExecResult, AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(3600));

    // Register cancellation token so sftp_cancel_transfer can stop us
    let cancel_token = tokio_util::sync::CancellationToken::new();
    if let Some(ref tid) = transfer_id {
        let mut map = state.transfer_cancellations.write().await;
        map.insert(tid.clone(), cancel_token.clone());
    }

    let mut channel = sess
        .handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("channel_open_session: {e}")))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

    let mut all_stdout = Vec::new();
    let mut all_stderr = Vec::new();
    let mut exit_code: Option<u32> = None;
    let mut got_eof = false;
    let mut cancelled = false;

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                cancelled = true;
                // Kill rsync/scp on the remote by running `kill` in a new channel.
                // channel.signal() is unreliable (OpenSSH often ignores it).
                // We grep for .prossh_ in the process list (our unique marker).
                let kill_cmd = "pkill -f '\\.prossh_' 2>/dev/null; true";
                if let Ok(mut kill_ch) = sess.handle.channel_open_session().await {
                    let _ = kill_ch.exec(true, kill_cmd.as_bytes()).await;
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        async { while kill_ch.wait().await.is_some() {} },
                    ).await;
                }
                let _ = channel.close().await;
                break;
            }
            result = tokio::time::timeout(timeout, channel.wait()) => {
                match result {
                    Ok(Some(msg)) => match msg {
                        russh::ChannelMsg::Data { ref data } => {
                            all_stdout.extend_from_slice(&data[..]);
                            let text = String::from_utf8_lossy(&data[..]).into_owned();
                            let _ = on_output.send(ExecChunk {
                                stdout: text,
                                stderr: String::new(),
                                exit_code: None,
                                done: false,
                            });
                        }
                        russh::ChannelMsg::ExtendedData { ref data, ext: _ } => {
                            all_stderr.extend_from_slice(&data[..]);
                            let text = String::from_utf8_lossy(&data[..]).into_owned();
                            let _ = on_output.send(ExecChunk {
                                stdout: String::new(),
                                stderr: text,
                                exit_code: None,
                                done: false,
                            });
                        }
                        russh::ChannelMsg::ExitStatus { exit_status } => {
                            exit_code = Some(exit_status);
                            if got_eof { break; }
                        }
                        russh::ChannelMsg::Eof => {
                            got_eof = true;
                            if exit_code.is_some() { break; }
                        }
                        russh::ChannelMsg::Close => break,
                        _ => {}
                    },
                    Ok(None) => break,
                    Err(_) => {
                        let _ = channel.close().await;
                        if let Some(ref tid) = transfer_id {
                            state.transfer_cancellations.write().await.remove(tid);
                        }
                        return Err(AppError::Ssh(format!(
                            "command did not finish within {timeout_secs:?}s"
                        )));
                    }
                }
            }
        }
    }

    // Clean up cancellation token
    if let Some(ref tid) = transfer_id {
        state.transfer_cancellations.write().await.remove(tid);
    }

    // Send final chunk
    let _ = on_output.send(ExecChunk {
        stdout: String::new(),
        stderr: String::new(),
        exit_code,
        done: true,
    });

    if cancelled {
        return Err(AppError::Ssh("transfer cancelled".into()));
    }

    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&all_stdout).into_owned(),
        stderr: String::from_utf8_lossy(&all_stderr).into_owned(),
        exit_code,
    })
}

/// Cancel an in-progress transfer.
#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), AppError> {
    let map = state.transfer_cancellations.read().await;
    if let Some(token) = map.get(&transfer_id) {
        token.cancel();
        tracing::info!(transfer_id = %transfer_id, "transfer cancelled");
    }
    Ok(())
}

/// Download a remote file to a temp directory and return the local path.
/// Used for drag-out operations — frontend will call the drag plugin's JS API.
#[tauri::command]
pub async fn sftp_download_temp(
    state: State<'_, AppState>,
    runtime_id: String,
    remote_path: String,
    file_name: String,
) -> Result<String, AppError> {
    let sess = get_session(&state, &runtime_id).await?;

    let temp_dir = std::env::temp_dir().join("prossh-drag");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| AppError::Io(format!("create temp dir: {e}")))?;
    let temp_path = temp_dir.join(&file_name);

    // Size is 0 here → download() streams until EOF.
    let fake_progress: Channel<TransferProgress> = Channel::new(|_| Ok(()));
    transfer::download(
        &sess.handle,
        &remote_path,
        &temp_path,
        0,
        format!("drag-{}", uuid::Uuid::new_v4()),
        &fake_progress,
        CancellationToken::new(),
    )
    .await?;

    Ok(temp_path.to_string_lossy().into_owned())
}

/// Download a remote file to a unique temp directory for editing in an external
/// editor. Each invocation gets its own subdirectory to avoid collisions when
/// editing files with the same name from different remote paths.
#[tauri::command]
pub async fn sftp_download_for_edit(
    state: State<'_, AppState>,
    runtime_id: String,
    remote_path: String,
    file_name: String,
) -> Result<String, AppError> {
    let sess = get_session(&state, &runtime_id).await?;

    let edit_id = uuid::Uuid::new_v4().to_string();
    let temp_dir = std::env::temp_dir()
        .join("prossh-edit")
        .join(&edit_id[..8]);
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| AppError::Io(format!("create edit temp dir: {e}")))?;
    let temp_path = temp_dir.join(&file_name);

    let fake_progress: Channel<TransferProgress> = Channel::new(|_| Ok(()));
    transfer::download(
        &sess.handle,
        &remote_path,
        &temp_path,
        0,
        format!("edit-{edit_id}"),
        &fake_progress,
        CancellationToken::new(),
    )
    .await?;

    Ok(temp_path.to_string_lossy().into_owned())
}

/// Return the last-modified timestamp (seconds since UNIX epoch, as f64) for
/// a local file. Used by the frontend to poll for changes while a file is open
/// in an external editor.
#[tauri::command]
pub async fn file_mtime(path: String) -> Result<f64, AppError> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| AppError::Io(format!("stat {path}: {e}")))?;
    let mtime = meta
        .modified()
        .map_err(|e| AppError::Io(format!("mtime: {e}")))?;
    let duration = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok(duration.as_secs_f64())
}

/// Open a local file with a specific editor executable, or fall back to the OS
/// default opener.
#[tauri::command]
pub async fn open_in_default_app(path: String, editor: Option<String>) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        if let Some(editor) = editor {
            std::process::Command::new(&editor)
                .arg(&path)
                .spawn()
                .map_err(|e| AppError::Io(format!("open with {editor}: {e}")))?;
            Ok(())
        } else {
            open::that(&path).map_err(|e| AppError::Io(format!("open {path}: {e}")))
        }
    })
    .await
    .map_err(|e| AppError::Internal(format!("join: {e}")))?
}

/// List entries in a local directory (so the frontend doesn't need fs plugin).
#[tauri::command]
pub async fn local_list(path: String) -> Result<Vec<LocalEntry>, AppError> {
    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| AppError::Io(format!("read_dir({path}): {e}")))?;

    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| AppError::Io(format!("next_entry: {e}")))?
    {
        let meta = entry
            .metadata()
            .await
            .map_err(|e| AppError::Io(format!("metadata: {e}")))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        entries.push(LocalEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Return the user's home directory.
#[tauri::command]
pub async fn local_home() -> Result<String, AppError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Internal("cannot determine home directory".into()))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Read a remote text file and return its content as a string.
/// Returns empty string if the file doesn't exist.
#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    runtime_id: String,
    path: String,
) -> Result<String, AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    use tokio::io::AsyncReadExt;
    match sess.sftp.open(&path).await {
        Ok(mut f) => {
            let mut buf = Vec::with_capacity(4096);
            f.read_to_end(&mut buf)
                .await
                .map_err(|e| AppError::Ssh(format!("read {path}: {e}")))?;
            Ok(String::from_utf8_lossy(&buf).into_owned())
        }
        Err(_) => Ok(String::new()), // file doesn't exist → empty
    }
}

/// Write text content to a remote file (creates or overwrites).
/// Optionally set POSIX permissions (e.g. 0o600 = 384 decimal).
#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, AppState>,
    runtime_id: String,
    path: String,
    content: String,
    #[allow(unused_variables)] permissions: Option<u32>,
) -> Result<(), AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    use tokio::io::AsyncWriteExt;
    let mut f = sess
        .sftp
        .create(&path)
        .await
        .map_err(|e| AppError::Ssh(format!("create {path}: {e}")))?;
    f.write_all(content.as_bytes())
        .await
        .map_err(|e| AppError::Ssh(format!("write {path}: {e}")))?;
    f.flush()
        .await
        .map_err(|e| AppError::Ssh(format!("flush {path}: {e}")))?;
    // Set permissions if requested
    if let Some(mode) = permissions {
        use russh_sftp::protocol::FileAttributes;
        let attrs = FileAttributes {
            permissions: Some(mode),
            ..Default::default()
        };
        sess.sftp
            .set_metadata(&path, attrs)
            .await
            .map_err(|e| AppError::Ssh(format!("chmod {path}: {e}")))?;
    }
    Ok(())
}

/// Set POSIX permissions on a remote file or directory.
#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    runtime_id: String,
    path: String,
    mode: u32,
) -> Result<(), AppError> {
    let sess = get_session(&state, &runtime_id).await?;
    use russh_sftp::protocol::FileAttributes;
    let attrs = FileAttributes {
        permissions: Some(mode),
        ..Default::default()
    };
    sess.sftp
        .set_metadata(&path, attrs)
        .await
        .map_err(|e| AppError::Ssh(format!("chmod {path}: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Server-to-server copy: auth preparation
// ---------------------------------------------------------------------------

/// What kind of auth was prepared for the server-to-server copy.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCopyAuth {
    /// "key" or "password"
    pub method: String,
    /// Remote path on the source server where the secret was written.
    pub remote_path: String,
    /// Whether sshpass is needed (password auth).
    pub needs_sshpass: bool,
}

/// Upload the destination session's SSH credentials to a temp file on the
/// source server, so that rsync/scp can authenticate source → destination
/// without ever modifying authorized_keys.
///
/// - Key auth: reads the local private key file, writes it to /tmp on source
/// - Password auth: reads the password from OS keyring, writes it to /tmp on source
///
/// Secrets never reach the frontend — everything happens in Rust.
#[tauri::command]
pub async fn prepare_server_copy_auth(
    state: State<'_, AppState>,
    dst_session_id: String,
    src_runtime_id: String,
    tmp_id: String,
) -> Result<ServerCopyAuth, AppError> {
    // 1. Load destination session from DB
    let conn = state.db.conn.clone();
    let sid = dst_session_id.clone();
    let dst = tokio::task::spawn_blocking(move || {
        let conn = conn.lock();
        repo::fetch_session(&conn, &sid)
    })
    .await
    .map_err(join_err)??;

    // 2. Get the SFTP session to the source server (for writing files)
    let src_sess = get_session(&state, &src_runtime_id).await?;

    // Helper: execute a command on the source server and return the result.
    // Continues reading after Eof to capture ExitStatus which may arrive later.
    async fn src_exec(
        handle: &russh::client::Handle<crate::ssh::ProsshHandler>,
        cmd: &str,
        timeout_secs: u64,
    ) -> Result<(String, String, Option<u32>), AppError> {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("channel_open_session: {e}")))?;
        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

        let timeout = std::time::Duration::from_secs(timeout_secs);
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code: Option<u32> = None;
        let mut got_eof = false;

        loop {
            match tokio::time::timeout(timeout, channel.wait()).await {
                Ok(Some(msg)) => match msg {
                    russh::ChannelMsg::Data { ref data } => stdout.extend_from_slice(&data[..]),
                    russh::ChannelMsg::ExtendedData { ref data, .. } => {
                        stderr.extend_from_slice(&data[..])
                    }
                    russh::ChannelMsg::ExitStatus { exit_status } => {
                        exit_code = Some(exit_status);
                        if got_eof { break; }
                    }
                    russh::ChannelMsg::Eof => {
                        got_eof = true;
                        // Don't break yet — ExitStatus often comes after Eof
                        if exit_code.is_some() { break; }
                    }
                    russh::ChannelMsg::Close => break,
                    _ => {}
                },
                Ok(None) => break,
                Err(_) => break,
            }
        }
        Ok((
            String::from_utf8_lossy(&stdout).into_owned(),
            String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
        ))
    }

    // Helper: write file content via stdin of `cat` with umask 077.
    // Much more reliable than heredoc through SSH exec.
    async fn src_write_file(
        handle: &russh::client::Handle<crate::ssh::ProsshHandler>,
        remote_path: &str,
        content: &[u8],
        timeout_secs: u64,
    ) -> Result<(String, Option<u32>), AppError> {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("channel_open_session: {e}")))?;

        let cmd = format!("(umask 077; cat > '{remote_path}')");
        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

        // Send the file content through channel stdin
        channel
            .data(content)
            .await
            .map_err(|e| AppError::Ssh(format!("data: {e}")))?;
        // Signal end of stdin
        channel
            .eof()
            .await
            .map_err(|e| AppError::Ssh(format!("eof: {e}")))?;

        let timeout = std::time::Duration::from_secs(timeout_secs);
        let mut stderr = Vec::new();
        let mut exit_code: Option<u32> = None;
        let mut got_eof = false;

        loop {
            match tokio::time::timeout(timeout, channel.wait()).await {
                Ok(Some(msg)) => match msg {
                    russh::ChannelMsg::ExtendedData { ref data, .. } => {
                        stderr.extend_from_slice(&data[..])
                    }
                    russh::ChannelMsg::ExitStatus { exit_status } => {
                        exit_code = Some(exit_status);
                        if got_eof { break; }
                    }
                    russh::ChannelMsg::Eof => {
                        got_eof = true;
                        if exit_code.is_some() { break; }
                    }
                    russh::ChannelMsg::Close => break,
                    _ => {}
                },
                Ok(None) => break,
                Err(_) => break,
            }
        }
        Ok((
            String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
        ))
    }

    // Resolve home dir on the source server
    let (home_out, _, _) = src_exec(&src_sess.handle, "echo $HOME", 5).await?;
    let home = home_out.trim();
    let home = if home.is_empty() { "/tmp" } else { home };

    match dst.auth_method {
        AuthMethod::Key => {
            let key_path_str = dst
                .private_key_path
                .as_deref()
                .ok_or_else(|| AppError::Ssh("destination has no private key configured".into()))?
                .to_owned();

            // Load the private key and decrypt it if it has a passphrase.
            // The decrypted key is re-encoded as unencrypted OpenSSH format
            // so the SSH client on the source server can use it with `-i`.
            let secret_k = secret_key(&dst.id);
            let passphrase = tokio::task::spawn_blocking({
                let k = secret_k.clone();
                move || secrets::get(&k)
            })
            .await
            .map_err(join_err)??;

            let key_content = tokio::task::spawn_blocking({
                let kp = key_path_str.clone();
                let pp = passphrase.clone();
                move || {
                    let key = russh::keys::load_secret_key(
                        std::path::Path::new(&kp),
                        pp.as_deref(),
                    )
                    .map_err(|e| AppError::Ssh(format!("load key {kp}: {e}")))?;

                    // Re-encode as unencrypted OpenSSH format (most compatible)
                    let openssh_str = key
                        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                        .map_err(|e| AppError::Ssh(format!("encode key: {e}")))?;
                    Ok::<String, AppError>(openssh_str.to_string())
                }
            })
            .await
            .map_err(join_err)??;

            // Write the key via channel stdin with umask 077 so the file is
            // created with 0600 permissions from the start. SFTP create uses
            // the server's default umask (often 0022 → 0644) which SSH rejects.
            // We pipe the key through stdin of `cat` instead of using heredoc,
            // which is unreliable over SSH exec on some servers.
            let remote_path = format!("{home}/.prossh_key_{tmp_id}");
            let (write_err, write_code) =
                src_write_file(&src_sess.handle, &remote_path, key_content.as_bytes(), 10)
                    .await?;
            if write_code.is_some() && write_code != Some(0) {
                return Err(AppError::Ssh(format!(
                    "failed to write key to {remote_path}: {write_err}"
                )));
            }

            Ok(ServerCopyAuth {
                method: "key".into(),
                remote_path,
                needs_sshpass: false,
            })
        }

        AuthMethod::Password => {
            // Read password from OS keychain
            let secret_k = secret_key(&dst.id);
            let password = tokio::task::spawn_blocking(move || secrets::get(&secret_k))
                .await
                .map_err(join_err)??
                .ok_or_else(|| AppError::Ssh("no password stored for destination session".into()))?;

            // Write password via exec with umask 077 (same reason as above)
            let remote_path = format!("{home}/.prossh_pass_{tmp_id}");
            // Write password via channel stdin (same approach as key above)
            let (write_err, write_code) =
                src_write_file(&src_sess.handle, &remote_path, password.as_bytes(), 10)
                    .await?;
            if write_code.is_some() && write_code != Some(0) {
                return Err(AppError::Ssh(format!(
                    "failed to write credentials to {remote_path}: {write_err}"
                )));
            }

            Ok(ServerCopyAuth {
                method: "password".into(),
                remote_path,
                needs_sshpass: true,
            })
        }

        AuthMethod::Agent => {
            Err(AppError::Ssh(
                "SSH agent auth not yet supported for server-to-server copy".into(),
            ))
        }
    }
}

/// Clean up temp auth files from the source server.
#[tauri::command]
pub async fn cleanup_server_copy_auth(
    state: State<'_, AppState>,
    src_runtime_id: String,
    remote_path: String,
) -> Result<(), AppError> {
    let src_sess = get_session(&state, &src_runtime_id).await?;
    // Best-effort delete via exec
    let mut channel = src_sess
        .handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("channel_open_session: {e}")))?;
    channel
        .exec(true, format!("rm -f '{remote_path}'").as_bytes())
        .await
        .map_err(|e| AppError::Ssh(format!("exec rm: {e}")))?;
    // Wait briefly for completion
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(_msg) = channel.wait().await {}
    })
    .await;
    Ok(())
}

// Helper
async fn get_session(
    state: &State<'_, AppState>,
    runtime_id: &str,
) -> Result<std::sync::Arc<crate::sftp::SftpSession>, AppError> {
    let map = state.sftp_sessions.read().await;
    map.get(runtime_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("sftp session {runtime_id}")))
}
