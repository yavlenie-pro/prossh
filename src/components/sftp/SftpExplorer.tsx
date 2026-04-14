import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  File,
  Folder,
  Loader2,
  RefreshCw,
  Trash2,
  FolderPlus,
  Upload,
  Download,
  AlertTriangle,
} from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import type { RemoteEntry, LocalEntry, TransferProgress } from "@/api/sftp";
import { sftpApi } from "@/api/sftp";
import { Button } from "@/components/ui/Button";
import { formatError } from "@/stores/sessions";
import type { Session } from "@/api/types";

interface Props {
  session: Session;
}

type Status = "connecting" | "connected" | "error" | "disconnected";

/**
 * Dual-pane SFTP file explorer: local (left) + remote (right).
 * Each panel shows a directory listing and supports navigation, upload/download.
 */
export function SftpExplorer({ session }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const runtimeIdRef = useRef<string | null>(null);

  // Remote state
  const [remotePath, setRemotePath] = useState("/");
  const [remoteEntries, setRemoteEntries] = useState<RemoteEntry[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);

  // Local state
  const [localPath, setLocalPath] = useState("");
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);

  // Transfers
  const [transfers, setTransfers] = useState<
    Map<string, { name: string; bytes: number; total: number; done: boolean }>
  >(new Map());

  // --- Connect ---
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Get local home
        const home = await sftpApi.localHome();
        if (!cancelled) setLocalPath(home);

        // Connect SFTP
        const rid = await sftpApi.open(session.id);
        if (cancelled) {
          void sftpApi.close(rid);
          return;
        }
        runtimeIdRef.current = rid;
        setStatus("connected");
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(formatError(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (runtimeIdRef.current) {
        void sftpApi.close(runtimeIdRef.current);
        runtimeIdRef.current = null;
      }
    };
  }, [session.id]);

  // --- Load remote dir ---
  const loadRemote = async (path: string) => {
    if (!runtimeIdRef.current) return;
    setRemoteLoading(true);
    try {
      const entries = await sftpApi.list(runtimeIdRef.current, path);
      setRemoteEntries(entries);
      setRemotePath(path);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setRemoteLoading(false);
    }
  };

  // --- Load local dir ---
  const loadLocal = async (path: string) => {
    setLocalLoading(true);
    try {
      const entries = await sftpApi.localList(path);
      setLocalEntries(entries);
      setLocalPath(path);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLocalLoading(false);
    }
  };

  // Load directories when connected
  useEffect(() => {
    if (status === "connected") {
      void loadRemote(remotePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (localPath) void loadLocal(localPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPath]);

  const parentDir = (path: string) => {
    const sep = path.includes("\\") ? "\\" : "/";
    const parts = path.split(sep).filter(Boolean);
    parts.pop();
    if (path.includes("\\")) {
      // Windows: keep drive letter
      return parts.length === 0 ? path.slice(0, 3) : parts.join(sep);
    }
    return "/" + parts.join("/");
  };

  const handleUpload = async (entry: LocalEntry) => {
    if (!runtimeIdRef.current || entry.isDir) return;
    const transferId = nanoid();
    const target = remotePath === "/"
      ? `/${entry.name}`
      : `${remotePath}/${entry.name}`;

    setTransfers((prev) => {
      const next = new Map(prev);
      next.set(transferId, {
        name: entry.name,
        bytes: 0,
        total: entry.size,
        done: false,
      });
      return next;
    });

    const onProgress = new Channel<TransferProgress>((msg) => {
      setTransfers((prev) => {
        const next = new Map(prev);
        next.set(msg.transferId, {
          name: entry.name,
          bytes: msg.bytes,
          total: msg.total,
          done: msg.done,
        });
        return next;
      });
    });

    try {
      await sftpApi.upload(
        runtimeIdRef.current,
        entry.path,
        target,
        transferId,
        onProgress,
      );
      void loadRemote(remotePath);
    } catch (e) {
      setError(formatError(e));
    }
  };

  const handleDownload = async (entry: RemoteEntry) => {
    if (!runtimeIdRef.current || entry.isDir) return;
    const transferId = nanoid();
    const sep = localPath.includes("\\") ? "\\" : "/";
    const target = `${localPath}${sep}${entry.name}`;

    setTransfers((prev) => {
      const next = new Map(prev);
      next.set(transferId, {
        name: entry.name,
        bytes: 0,
        total: entry.size,
        done: false,
      });
      return next;
    });

    const onProgress = new Channel<TransferProgress>((msg) => {
      setTransfers((prev) => {
        const next = new Map(prev);
        next.set(msg.transferId, {
          name: entry.name,
          bytes: msg.bytes,
          total: msg.total,
          done: msg.done,
        });
        return next;
      });
    });

    try {
      await sftpApi.download(
        runtimeIdRef.current,
        entry.path,
        target,
        entry.size,
        transferId,
        onProgress,
      );
      void loadLocal(localPath);
    } catch (e) {
      setError(formatError(e));
    }
  };

  const handleRemoteDelete = async (entry: RemoteEntry) => {
    if (!runtimeIdRef.current) return;
    const yes = await ask(t("sftp.deleteConfirm", { type: entry.isDir ? t("sftp.directory") : t("sftp.file"), name: entry.name }), { title: "ProSSH", kind: "warning" });
    if (!yes) return;
    try {
      if (entry.isDir) {
        await sftpApi.rmdir(runtimeIdRef.current, entry.path);
      } else {
        await sftpApi.remove(runtimeIdRef.current, entry.path);
      }
      void loadRemote(remotePath);
    } catch (e) {
      setError(formatError(e));
    }
  };

  const handleMkdir = async () => {
    if (!runtimeIdRef.current) return;
    const name = prompt(t("sftp.newDir"));
    if (!name) return;
    const path = remotePath === "/" ? `/${name}` : `${remotePath}/${name}`;
    try {
      await sftpApi.mkdir(runtimeIdRef.current, path);
      void loadRemote(remotePath);
    } catch (e) {
      setError(formatError(e));
    }
  };

  if (status === "connecting") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("sftp.connecting", { host: session.host })}
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md rounded-lg border border-danger/30 bg-bg-elevated px-6 py-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-danger">
            <AlertTriangle className="h-4 w-4" />
            {t("sftp.connectionFailed")}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-xs text-fg-muted">
            {error}
          </pre>
        </div>
      </div>
    );
  }

  const activeTransfers = [...transfers.values()].filter((t) => !t.done);

  return (
    <div className="flex h-full flex-col">
      {/* Two-panel file browser */}
      <div className="flex min-h-0 flex-1">
        {/* Local panel */}
        <div className="flex w-1/2 flex-col border-r border-border-subtle">
          <div className="flex items-center gap-1 border-b border-border-subtle bg-bg-elevated px-2 py-1">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setLocalPath(parentDir(localPath))}
              title="Go up"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <div className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
              {localPath}
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void loadLocal(localPath)}
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {localLoading ? (
              <div className="flex items-center justify-center py-8 text-xs text-fg-muted">
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            ) : (
              localEntries.map((e) => (
                <FileRow
                  key={e.path}
                  name={e.name}
                  isDir={e.isDir}
                  size={e.size}
                  onOpen={() => e.isDir && setLocalPath(e.path)}
                  actionIcon={!e.isDir ? <Upload className="h-3 w-3" /> : undefined}
                  onAction={() => void handleUpload(e)}
                  actionTitle="Upload"
                />
              ))
            )}
          </div>
        </div>

        {/* Remote panel */}
        <div className="flex w-1/2 flex-col">
          <div className="flex items-center gap-1 border-b border-border-subtle bg-bg-elevated px-2 py-1">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void loadRemote(parentDir(remotePath))}
              title="Go up"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <div className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
              {remotePath}
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={handleMkdir}
              title="New directory"
            >
              <FolderPlus className="h-3 w-3" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void loadRemote(remotePath)}
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {remoteLoading ? (
              <div className="flex items-center justify-center py-8 text-xs text-fg-muted">
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            ) : (
              remoteEntries.map((e) => (
                <FileRow
                  key={e.path}
                  name={e.name}
                  isDir={e.isDir}
                  size={e.size}
                  onOpen={() => e.isDir && void loadRemote(e.path)}
                  actionIcon={
                    e.isDir ? (
                      <Trash2 className="h-3 w-3" />
                    ) : (
                      <Download className="h-3 w-3" />
                    )
                  }
                  onAction={() =>
                    e.isDir
                      ? void handleRemoteDelete(e)
                      : void handleDownload(e)
                  }
                  actionTitle={e.isDir ? "Delete" : "Download"}
                  secondAction={
                    !e.isDir
                      ? {
                          icon: <Trash2 className="h-3 w-3" />,
                          onClick: () => void handleRemoteDelete(e),
                          title: "Delete",
                        }
                      : undefined
                  }
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Transfer queue */}
      {activeTransfers.length > 0 && (
        <div className="border-t border-border-subtle bg-bg-elevated px-3 py-2">
          <div className="mb-1 text-xs font-medium text-fg-muted">
            {t("sftp.transfers")} ({activeTransfers.length})
          </div>
          {activeTransfers.map((t, i) => {
            const pct = t.total > 0 ? Math.round((t.bytes / t.total) * 100) : 0;
            return (
              <div key={i} className="mb-1 flex items-center gap-2 text-xs text-fg-muted">
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <div className="h-1.5 w-24 rounded-full bg-bg-overlay">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-10 text-right">{pct}%</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FileRow({
  name,
  isDir,
  size,
  onOpen,
  actionIcon,
  onAction,
  actionTitle,
  secondAction,
}: {
  name: string;
  isDir: boolean;
  size: number;
  onOpen: () => void;
  actionIcon?: React.ReactNode;
  onAction?: () => void;
  actionTitle?: string;
  secondAction?: {
    icon: React.ReactNode;
    onClick: () => void;
    title: string;
  };
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className="group flex cursor-pointer items-center gap-2 px-2 py-1 text-xs hover:bg-bg-overlay"
    >
      {isDir ? (
        <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
      ) : (
        <File className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      )}
      <span className="min-w-0 flex-1 truncate text-fg">{name}</span>
      {!isDir && (
        <span className="shrink-0 text-fg-subtle">{formatSize(size)}</span>
      )}
      {actionIcon && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAction?.();
          }}
          className="hidden rounded p-0.5 text-fg-subtle hover:bg-bg-elevated hover:text-fg group-hover:block"
          title={actionTitle}
        >
          {actionIcon}
        </button>
      )}
      {secondAction && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            secondAction.onClick();
          }}
          className="hidden rounded p-0.5 text-fg-subtle hover:bg-danger/20 hover:text-danger group-hover:block"
          title={secondAction.title}
        >
          {secondAction.icon}
        </button>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
