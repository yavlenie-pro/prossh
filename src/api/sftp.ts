/**
 * Typed wrappers for SFTP IPC commands.
 */
import { invoke, Channel } from "@tauri-apps/api/core";

export interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
  uid: number | null;
  gid: number | null;
  owner: string | null;
  group: string | null;
}

export interface LocalEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface TransferProgress {
  transferId: string;
  bytes: number;
  total: number;
  done: boolean;
  cancelled: boolean;
  error: string | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ExecChunk {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  done: boolean;
}

export const sftpApi = {
  open: (sessionId: string) =>
    invoke<string>("sftp_open", { sessionId }),

  close: (runtimeId: string) =>
    invoke<void>("sftp_close", { runtimeId }),

  list: (runtimeId: string, path: string) =>
    invoke<RemoteEntry[]>("sftp_list", { runtimeId, path }),

  mkdir: (runtimeId: string, path: string) =>
    invoke<void>("sftp_mkdir", { runtimeId, path }),

  rmdir: (runtimeId: string, path: string) =>
    invoke<void>("sftp_rmdir", { runtimeId, path }),

  remove: (runtimeId: string, path: string) =>
    invoke<void>("sftp_remove", { runtimeId, path }),

  touch: (runtimeId: string, path: string) =>
    invoke<void>("sftp_touch", { runtimeId, path }),

  rename: (runtimeId: string, from: string, to: string) =>
    invoke<void>("sftp_rename", { runtimeId, from, to }),

  upload: (
    runtimeId: string,
    localPath: string,
    remotePath: string,
    transferId: string,
    onProgress: Channel<TransferProgress>,
  ) =>
    invoke<void>("sftp_upload", {
      runtimeId,
      localPath,
      remotePath,
      transferId,
      onProgress,
    }),

  download: (
    runtimeId: string,
    remotePath: string,
    localPath: string,
    totalSize: number,
    transferId: string,
    onProgress: Channel<TransferProgress>,
  ) =>
    invoke<void>("sftp_download", {
      runtimeId,
      remotePath,
      localPath,
      totalSize,
      transferId,
      onProgress,
    }),

  /** Copy a file directly between two remote servers (server-to-server). */
  serverCopy: (
    srcRuntimeId: string,
    srcPath: string,
    dstRuntimeId: string,
    dstPath: string,
    totalSize: number,
    transferId: string,
    onProgress: Channel<TransferProgress>,
  ) =>
    invoke<void>("sftp_server_copy", {
      srcRuntimeId,
      srcPath,
      dstRuntimeId,
      dstPath,
      totalSize,
      transferId,
      onProgress,
    }),

  cancelTransfer: (transferId: string) =>
    invoke<void>("sftp_cancel_transfer", { transferId }),

  downloadTemp: (runtimeId: string, remotePath: string, fileName: string) =>
    invoke<string>("sftp_download_temp", { runtimeId, remotePath, fileName }),

  /** Download a remote file to a unique temp directory for external editing. */
  downloadForEdit: (runtimeId: string, remotePath: string, fileName: string) =>
    invoke<string>("sftp_download_for_edit", { runtimeId, remotePath, fileName }),

  /** Get the last-modified time (seconds since epoch) of a local file. */
  fileMtime: (path: string) => invoke<number>("file_mtime", { path }),

  /** Open a local file with a specific editor or the OS default app. */
  openInDefaultApp: (path: string, editor?: string) =>
    invoke<void>("open_in_default_app", { path, editor: editor ?? null }),


  /** Read a text file on the remote server. Returns empty string if not found. */
  readText: (runtimeId: string, path: string) =>
    invoke<string>("sftp_read_text", { runtimeId, path }),

  /** Write text to a remote file (creates or overwrites). */
  writeText: (runtimeId: string, path: string, content: string, permissions?: number) =>
    invoke<void>("sftp_write_text", { runtimeId, path, content, permissions: permissions ?? null }),

  /** Set POSIX permissions on a remote file/dir (e.g. 0o700 = 448). */
  chmod: (runtimeId: string, path: string, mode: number) =>
    invoke<void>("sftp_chmod", { runtimeId, path, mode }),

  /** Execute a command on a remote server via the SFTP session's SSH handle. */
  remoteExec: (runtimeId: string, command: string, timeoutSecs?: number) =>
    invoke<ExecResult>("ssh_remote_exec", {
      runtimeId,
      command,
      timeoutSecs: timeoutSecs ?? null,
    }),

  /** Execute a command with real-time stdout/stderr streaming via Channel.
   *  Pass transferId to enable cancellation via sftp_cancel_transfer. */
  remoteExecStream: (
    runtimeId: string,
    command: string,
    onChunk: (chunk: ExecChunk) => void,
    timeoutSecs?: number,
    transferId?: string,
  ) => {
    const channel = new Channel<ExecChunk>();
    channel.onmessage = onChunk;
    return invoke<ExecResult>("ssh_remote_exec_stream", {
      runtimeId,
      command,
      transferId: transferId ?? null,
      timeoutSecs: timeoutSecs ?? null,
      onOutput: channel,
    });
  },

  /** Upload destination's SSH credentials to a temp file on the source server.
   *  Secrets stay in Rust — never exposed to the frontend. */
  prepareServerCopyAuth: (dstSessionId: string, srcRuntimeId: string, tmpId: string) =>
    invoke<{ method: string; remotePath: string; needsSshpass: boolean }>(
      "prepare_server_copy_auth",
      { dstSessionId, srcRuntimeId, tmpId },
    ),

  /** Clean up the temp auth file from the source server. */
  cleanupServerCopyAuth: (srcRuntimeId: string, remotePath: string) =>
    invoke<void>("cleanup_server_copy_auth", { srcRuntimeId, remotePath }),

  localList: (path: string) =>
    invoke<LocalEntry[]>("local_list", { path }),

  localHome: () => invoke<string>("local_home"),
};
