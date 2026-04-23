/**
 * Sidebar file browser — navigates the remote filesystem of the active SSH
 * session via SFTP. Supports upload, download, drag-and-drop (in and out),
 * create directory, create file. Context menu for per-entry actions.
 */

/** Extract a human-readable message from Tauri invoke errors (which may be
 *  plain strings, Error instances, or arbitrary objects). */
function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    try { return JSON.stringify(e); } catch { /* fallback */ }
  }
  return String(e);
}

/** Map known Rust error strings to i18n keys. Falls back to the raw message. */
const ERROR_MAP: [RegExp, string][] = [
  [/public key auth rejected/i, "sftp.errors.keyRejected"],
  [/no password stored/i, "sftp.errors.noPassword"],
  [/auth.*fail/i, "sftp.errors.authFailed"],
  [/timed?\s*out/i, "sftp.errors.timeout"],
  [/connection.*refused/i, "sftp.errors.connRefused"],
  [/could not resolve/i, "sftp.errors.dnsResolve"],
  [/host.?key.?mismatch/i, "sftp.errors.hostKeyMismatch"],
];

function localizeError(raw: string, t: (key: string) => string): string {
  for (const [re, key] of ERROR_MAP) {
    if (re.test(raw)) {
      const localized = t(key);
      // If the key itself is returned (no translation), fall back to raw
      if (localized !== key) return localized;
    }
  }
  return raw;
}
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { save, open, ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  ExternalLink,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  FolderUp,
  Loader2,
  Maximize2,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { RemoteEntry, TransferProgress } from "@/api/sftp";
import { sftpApi } from "@/api/sftp";
import { settingsApi } from "@/api/settings";
import { cn } from "@/lib/cn";
import { useSessionsStore } from "@/stores/sessions";
import { useTabsStore } from "@/stores/tabs";
import { useTransfersStore } from "@/stores/transfers";

import { CopyToServerDialog } from "@/components/dialogs/CopyToServerDialog";

import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Tooltip from "@radix-ui/react-tooltip";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPermissions(mode: number | null): string {
  if (mode == null) return "---";
  const octal = mode & 0o7777;
  const chars = "rwxrwxrwx";
  let result = "";
  for (let i = 8; i >= 0; i--) {
    result += octal & (1 << i) ? chars[8 - i] : "-";
  }
  return result;
}

function formatDate(ts: number | null): string {
  if (ts == null) return "\u2014";
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function entryTooltip(entry: RemoteEntry): string {
  const lines: string[] = [entry.path];
  if (!entry.isDir) lines.push(`Size: ${formatSize(entry.size)}`);
  if (entry.permissions != null)
    lines.push(
      `Permissions: ${formatPermissions(entry.permissions)} (${(entry.permissions & 0o7777).toString(8).padStart(3, "0")})`,
    );
  const ownerParts: string[] = [];
  if (entry.owner) ownerParts.push(entry.owner);
  else if (entry.uid != null) ownerParts.push(`uid=${entry.uid}`);
  if (entry.group) ownerParts.push(entry.group);
  else if (entry.gid != null) ownerParts.push(`gid=${entry.gid}`);
  if (ownerParts.length) lines.push(`Owner: ${ownerParts.join(":")}`);
  if (entry.modified != null)
    lines.push(`Modified: ${formatDate(entry.modified)}`);
  return lines.join("\n");
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** Pending upload waiting for overwrite confirmation. */
interface PendingUpload {
  localPath: string;
  targetDir: string;
  fileName: string;
  remoteDest: string;
}

const DRAG_MIME = "application/x-prossh-entry";

// 1x1 transparent PNG for drag icon (base64)
const DRAG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualKQAAAABJRU5ErkJggg==";

// ─── Component ────────────────────────────────────────────────────────────────

export function FilesBrowser() {
  const { t } = useTranslation();
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("/");
  /** Mirror of `cwd` that the user can edit in the path input. Committed on
   *  Enter (navigates) or reverted on Escape / blur without changes. */
  const [pathDraft, setPathDraft] = useState("/");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [osDragOver, setOsDragOver] = useState(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [draggingEntry, setDraggingEntry] = useState<string | null>(null);

  const historyRef = useRef<string[]>(["/"]);
  const historyIndexRef = useRef(0);
  const sftpForSession = useRef<string | null>(null);

  // Overwrite confirmation
  const [overwritePrompt, setOverwritePrompt] = useState<PendingUpload | null>(null);
  const [overwriteQueue, setOverwriteQueue] = useState<PendingUpload[]>([]);
  const overwriteAllRef = useRef<"none" | "yes" | "no">("none");

  // Active edits (files open in external editor).
  // Monitoring runs until the user dismisses it (×) — like WinSCP / FileZilla.
  interface ActiveEdit {
    id: string;
    tempPath: string;
    remotePath: string;
    fileName: string;
    lastMtime: number;
    uploading: boolean;
    autoUpload: boolean;
    pendingUpload: boolean;
  }
  const [activeEdits, setActiveEdits] = useState<ActiveEdit[]>([]);
  const [editorPath, setEditorPath] = useState<string | null>(null);

  // Copy-to-server dialog
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copyEntries, setCopyEntries] = useState<RemoteEntry[]>([]);

  // Load stored editor path
  useEffect(() => {
    void settingsApi.get("editor.path").then((v) => setEditorPath(v || null)).catch(() => {});
  }, []);

  // Transfer store
  const addTransfer = useTransfersStore((s) => s.addTransfer);
  const updateProgress = useTransfersStore((s) => s.updateProgress);
  const markDone = useTransfersStore((s) => s.markDone);
  const markCancelled = useTransfersStore((s) => s.markCancelled);
  const markError = useTransfersStore((s) => s.markError);

  const sessionId = useTabsStore((s) => {
    const { tabs, activeTabId } = s;
    const tab = tabs.find((t) => t.id === activeTabId);
    return tab?.sessionId ?? null;
  });

  const sessionName = useSessionsStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId)?.name ?? null : null,
  );

  /** Escalate the sidebar file view into a full dual-pane SFTP tab for the
   *  currently active session. Noop when no session is active. */
  const openSftpTab = () => {
    if (!sessionId) return;
    useTabsStore.getState().openSftpTab(sessionId, sessionName ?? sessionId);
  };

  // Track the initial dir to open after SFTP connects
  const initialDirRef = useRef<string>("/");

  // ── SFTP lifecycle ──────────────────────────────────────────────────────────
  // Cache SFTP connections by sessionId so switching tabs doesn't kill
  // background operations (rsync, transfers, etc.)
  const sftpCacheRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!sessionId || sessionId === sftpForSession.current) return;

    // Save current sftpId in cache (do NOT close it)
    if (sftpForSession.current && sftpId) {
      sftpCacheRef.current.set(sftpForSession.current, sftpId);
    }

    sftpForSession.current = sessionId;
    setConnecting(true);
    setError(null);
    setEntries([]);
    setCwd("/");
    historyRef.current = ["/"];
    historyIndexRef.current = 0;

    // Check if we already have a cached connection for this session
    const cached = sftpCacheRef.current.get(sessionId);
    if (cached) {
      sftpCacheRef.current.delete(sessionId);
      setSftpId(cached);
      setConnecting(false);
      return;
    }

    // Try to restore last dir for this session
    const sid = sessionId;
    void (async () => {
      try {
        const enabled = await settingsApi.get("sftp.rememberLastDir");
        if (enabled !== "false") {
          const saved = await settingsApi.get(`sftp.lastDir.${sid}`);
          if (saved) initialDirRef.current = saved;
          else initialDirRef.current = "/";
        } else {
          initialDirRef.current = "/";
        }
      } catch {
        initialDirRef.current = "/";
      }
      try {
        setSftpId(await sftpApi.open(sid));
        setConnecting(false);
      } catch (e) {
        setError(errMsg(e));
        setConnecting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    return () => {
      // On unmount, close ALL cached connections + current
      if (sftpId) void sftpApi.close(sftpId);
      for (const rid of sftpCacheRef.current.values()) {
        void sftpApi.close(rid);
      }
      sftpCacheRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Directory loading ───────────────────────────────────────────────────────

  /** Persist last SFTP dir for the current session. */
  const saveCwd = useCallback(
    (path: string) => {
      if (!sessionId) return;
      void settingsApi.get("sftp.rememberLastDir").then((v) => {
        if (v !== "false") {
          void settingsApi.set(`sftp.lastDir.${sessionId}`, path);
        }
      });
    },
    [sessionId],
  );

  const loadDir = useCallback(
    async (path: string) => {
      if (!sftpId) return;
      setLoading(true);
      try {
        const list = await sftpApi.list(sftpId, path);
        setEntries(list);
        setCwd(path);
        setPathDraft(path);
        saveCwd(path);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [sftpId, saveCwd],
  );

  // Load initial dir on SFTP connect (restored or "/")
  useEffect(() => {
    if (!sftpId) return;
    const startDir = initialDirRef.current;
    void (async () => {
      // Try the saved dir first; if it fails (deleted, no perms), fall back to /
      try {
        const list = await sftpApi.list(sftpId, startDir);
        setEntries(list);
        setCwd(startDir);
        setPathDraft(startDir);
        historyRef.current = [startDir];
        historyIndexRef.current = 0;
      } catch {
        // Fallback to root
        void loadDir("/");
      }
    })();
  }, [sftpId, loadDir]);

  const navigateTo = useCallback(
    (path: string) => {
      const idx = historyIndexRef.current;
      historyRef.current = historyRef.current.slice(0, idx + 1);
      historyRef.current.push(path);
      historyIndexRef.current = historyRef.current.length - 1;
      void loadDir(path);
    },
    [loadDir],
  );

  const canGoBack = historyIndexRef.current > 0;
  const canGoForward =
    historyIndexRef.current < historyRef.current.length - 1;

  const goBack = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    void loadDir(historyRef.current[historyIndexRef.current]);
  }, [loadDir]);

  const goForward = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    void loadDir(historyRef.current[historyIndexRef.current]);
  }, [loadDir]);

  const goUp = () => {
    if (cwd === "/") return;
    const parent = cwd.split("/").slice(0, -1).join("/") || "/";
    navigateTo(parent);
  };

  /** Commit the path the user typed into the input: normalise slashes,
   *  collapse duplicates, drop trailing slash, and navigate. Empty input
   *  resolves to `/`. If the result equals `cwd` we just refresh. */
  const commitPathDraft = () => {
    let p = pathDraft.trim();
    if (!p) p = "/";
    if (!p.startsWith("/")) p = "/" + p;
    p = p.replace(/\/+/g, "/");
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    if (p === cwd) {
      setPathDraft(cwd);
      void loadDir(cwd);
    } else {
      navigateTo(p);
    }
  };

  const refresh = () => void loadDir(cwd);

  // Intercept F5 inside the file browser so it refreshes the file list
  // instead of reloading the entire webview (which reconnects the session).
  useEffect(() => {
    const el = document.getElementById("files-browser");
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F5") {
        e.preventDefault();
        e.stopPropagation();
        refresh();
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  });

  // ── Mouse back/forward ──────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener("mouseup", handler);
    return () => window.removeEventListener("mouseup", handler);
  }, [goBack, goForward]);

  // ── Transfer helpers (with progress tracking) ───────────────────────────────

  /** Perform the actual upload (no existence check). */
  const doUploadDirect = useCallback(
    async (localPath: string, remoteDest: string, fileName: string) => {
      if (!sftpId) return;
      const transferId = crypto.randomUUID();

      addTransfer(transferId, fileName, "upload", 0);

      const ch = new Channel<TransferProgress>((msg) => {
        updateProgress(msg.transferId, msg.bytes, msg.total);
        if (msg.done) {
          if (msg.cancelled) markCancelled(msg.transferId);
          else if (msg.error) markError(msg.transferId, msg.error);
          else markDone(msg.transferId);
        }
      });

      try {
        await sftpApi.upload(sftpId, localPath, remoteDest, transferId, ch);
        refresh();
      } catch (e) {
        const err = errMsg(e);
        if (!err.includes("cancelled")) {
          // If session expired, try to reconnect and retry once
          if (err.includes("session") && sessionId) {
            try {
              const newId = await sftpApi.open(sessionId);
              setSftpId(newId);
              await sftpApi.upload(newId, localPath, remoteDest, transferId, ch);
              refresh();
              return;
            } catch (e2) {
              markError(transferId, errMsg(e2));
              return;
            }
          }
          markError(transferId, err);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sftpId, sessionId, cwd, addTransfer, updateProgress, markDone, markCancelled, markError],
  );

  /** Process the next pending overwrite prompt (if any). */
  const processOverwriteQueue = useCallback((queue: PendingUpload[]) => {
    if (queue.length === 0) {
      setOverwritePrompt(null);
      setOverwriteQueue([]);
      return;
    }
    const [next, ...rest] = queue;
    setOverwritePrompt(next);
    setOverwriteQueue(rest);
  }, []);

  /** Handle overwrite answer. */
  const handleOverwriteAnswer = useCallback(
    (answer: "yes" | "no" | "yesAll" | "noAll") => {
      const pending = overwritePrompt;
      if (!pending) return;

      if (answer === "yesAll") {
        overwriteAllRef.current = "yes";
        void doUploadDirect(pending.localPath, pending.remoteDest, pending.fileName);
        // Upload all remaining in queue too
        for (const p of overwriteQueue) {
          void doUploadDirect(p.localPath, p.remoteDest, p.fileName);
        }
        setOverwritePrompt(null);
        setOverwriteQueue([]);
        return;
      }

      if (answer === "noAll") {
        overwriteAllRef.current = "no";
        setOverwritePrompt(null);
        setOverwriteQueue([]);
        return;
      }

      if (answer === "yes") {
        void doUploadDirect(pending.localPath, pending.remoteDest, pending.fileName);
      }
      // "no" — just skip

      processOverwriteQueue(overwriteQueue);
    },
    [overwritePrompt, overwriteQueue, doUploadDirect, processOverwriteQueue],
  );

  /** Check existence and upload with overwrite prompt. */
  const doUpload = useCallback(
    async (localPath: string, targetDir: string) => {
      if (!sftpId) return;
      const fileName = localPath.split(/[/\\]/).pop() ?? "file";
      const remoteDest = joinPath(targetDir, fileName);

      // Check if file already exists on server
      let exists = false;
      if (targetDir === cwd) {
        // Fast path: check current entries
        exists = entries.some((e) => !e.isDir && e.name === fileName);
      } else {
        // Slow path: list the target dir
        try {
          const listing = await sftpApi.list(sftpId, targetDir);
          exists = listing.some((e) => !e.isDir && e.name === fileName);
        } catch {
          // Can't check — assume doesn't exist
        }
      }

      if (!exists) {
        void doUploadDirect(localPath, remoteDest, fileName);
        return;
      }

      // File exists — check "for all" preference
      if (overwriteAllRef.current === "yes") {
        void doUploadDirect(localPath, remoteDest, fileName);
        return;
      }
      if (overwriteAllRef.current === "no") {
        return; // Skip
      }

      // Need to ask — queue it
      const pending: PendingUpload = { localPath, targetDir, fileName, remoteDest };
      if (overwritePrompt) {
        // Already showing a prompt — add to queue
        setOverwriteQueue((q) => [...q, pending]);
      } else {
        setOverwritePrompt(pending);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sftpId, cwd, entries, doUploadDirect, overwritePrompt],
  );

  const doDownload = useCallback(
    async (entry: RemoteEntry, localDest: string) => {
      if (!sftpId) return;
      const transferId = crypto.randomUUID();

      addTransfer(transferId, entry.name, "download", entry.size);

      const ch = new Channel<TransferProgress>((msg) => {
        updateProgress(msg.transferId, msg.bytes, msg.total);
        if (msg.done) {
          if (msg.cancelled) markCancelled(msg.transferId);
          else if (msg.error) markError(msg.transferId, msg.error);
          else markDone(msg.transferId);
        }
      });

      try {
        await sftpApi.download(
          sftpId,
          entry.path,
          localDest,
          entry.size,
          transferId,
          ch,
        );
      } catch (e) {
        const err = errMsg(e);
        if (!err.includes("cancelled")) {
          markError(transferId, err);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sftpId, addTransfer, updateProgress, markDone, markCancelled, markError],
  );

  // ── File operations ─────────────────────────────────────────────────────────

  const handleMkdir = async () => {
    const name = prompt(t("files.newDirName"));
    if (!name?.trim() || !sftpId) return;
    try {
      await sftpApi.mkdir(sftpId, joinPath(cwd, name.trim()));
      refresh();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const handleTouch = async () => {
    const name = prompt(t("files.newFileName"));
    if (!name?.trim() || !sftpId) return;
    try {
      await sftpApi.touch(sftpId, joinPath(cwd, name.trim()));
      refresh();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const handleRename = async (entry: RemoteEntry) => {
    if (!sftpId) return;
    const newName = prompt(t("files.renamePrompt"), entry.name);
    if (!newName?.trim() || newName.trim() === entry.name) return;
    const parentDir = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";
    const newPath = joinPath(parentDir, newName.trim());
    try {
      await sftpApi.rename(sftpId, entry.path, newPath);
      refresh();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const handleDelete = async (entry: RemoteEntry) => {
    if (!sftpId) return;
    const kind = entry.isDir ? t("sftp.directory") : t("sftp.file");
    const yes = await ask(t("sftp.deleteConfirm", { type: kind, name: entry.name }), { title: "ProSSH", kind: "warning" });
    if (!yes) return;
    setDeletingPath(entry.path);
    try {
      if (entry.isDir) await sftpApi.rmdir(sftpId, entry.path);
      else await sftpApi.remove(sftpId, entry.path);
      refresh();
    } catch (e) {
      alert(errMsg(e));
    } finally {
      setDeletingPath(null);
    }
  };

  const handleDownload = async (entry: RemoteEntry) => {
    if (!sftpId) return;
    const dest = await save({ defaultPath: entry.name });
    if (!dest) return;
    await doDownload(entry, dest);
  };

  /** Pick or reuse the editor executable, open the file. Returns false if cancelled. */
  const openInEditor = async (filePath: string): Promise<boolean> => {
    let editor = editorPath;
    if (!editor) {
      const selected = await open({
        title: t("files.chooseEditor"),
        multiple: false,
        filters: [
          { name: "Applications", extensions: ["exe", "cmd", "bat"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (!selected) return false;
      editor = typeof selected === "string" ? selected : String(selected);
      setEditorPath(editor);
      void settingsApi.set("editor.path", editor);
    }
    await sftpApi.openInDefaultApp(filePath, editor);
    return true;
  };

  const handleEditFile = async (entry: RemoteEntry) => {
    if (!sftpId || entry.isDir) return;

    // Dedup: if already editing this remote path, just re-open in editor
    const existing = activeEdits.find((e) => e.remotePath === entry.path);
    if (existing) {
      try {
        await openInEditor(existing.tempPath);
      } catch (e) {
        alert(errMsg(e));
      }
      return;
    }

    try {
      const tempPath = await sftpApi.downloadForEdit(sftpId, entry.path, entry.name);
      const mtime = await sftpApi.fileMtime(tempPath);
      const opened = await openInEditor(tempPath);
      if (!opened) return;
      const editId = crypto.randomUUID();
      setActiveEdits((prev) => [
        ...prev,
        {
          id: editId,
          tempPath,
          remotePath: entry.path,
          fileName: entry.name,
          lastMtime: mtime,
          uploading: false,
          autoUpload: false,
          pendingUpload: false,
        },
      ]);
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const dismissEdit = (editId: string) => {
    setActiveEdits((prev) => prev.filter((e) => e.id !== editId));
  };

  /** Upload a pending edit back to the server. */
  const doEditUpload = async (editId: string) => {
    const edit = activeEdits.find((e) => e.id === editId);
    if (!edit || !sftpId) return;
    setActiveEdits((prev) =>
      prev.map((e) => (e.id === editId ? { ...e, uploading: true, pendingUpload: false } : e)),
    );
    try {
      await new Promise((r) => setTimeout(r, 500));
      const transferId = crypto.randomUUID();
      const ch = new Channel<TransferProgress>(() => {});
      await sftpApi.upload(sftpId, edit.tempPath, edit.remotePath, transferId, ch);
      refresh();
      const newMtime = await sftpApi.fileMtime(edit.tempPath);
      setActiveEdits((prev) =>
        prev.map((e) => (e.id === editId ? { ...e, uploading: false, lastMtime: newMtime } : e)),
      );
    } catch {
      setActiveEdits((prev) =>
        prev.map((e) => (e.id === editId ? { ...e, uploading: false } : e)),
      );
    }
  };

  /** Skip this pending upload. */
  const skipEditUpload = (editId: string) => {
    setActiveEdits((prev) =>
      prev.map((e) => (e.id === editId ? { ...e, pendingUpload: false } : e)),
    );
  };

  /** Enable auto-upload for this edit and upload the current change now. */
  const enableAutoUpload = (editId: string) => {
    setActiveEdits((prev) =>
      prev.map((e) => (e.id === editId ? { ...e, autoUpload: true, pendingUpload: false } : e)),
    );
    void doEditUpload(editId);
  };

  // Poll active edits for mtime changes (every 2s).
  // Monitoring persists until the user dismisses it via the × button.
  useEffect(() => {
    if (activeEdits.length === 0) return;
    const timer = setInterval(async () => {
      for (const edit of activeEdits) {
        if (edit.uploading || edit.pendingUpload || !sftpId) continue;
        try {
          const currentMtime = await sftpApi.fileMtime(edit.tempPath);
          if (currentMtime > edit.lastMtime) {
            if (edit.autoUpload) {
              setActiveEdits((prev) =>
                prev.map((e) =>
                  e.id === edit.id ? { ...e, uploading: true, lastMtime: currentMtime } : e,
                ),
              );
              await new Promise((r) => setTimeout(r, 500));
              try {
                const tid = crypto.randomUUID();
                const ch = new Channel<TransferProgress>(() => {});
                await sftpApi.upload(sftpId, edit.tempPath, edit.remotePath, tid, ch);
                const newMtime = await sftpApi.fileMtime(edit.tempPath);
                setActiveEdits((prev) =>
                  prev.map((e) =>
                    e.id === edit.id ? { ...e, uploading: false, lastMtime: newMtime } : e,
                  ),
                );
                refresh();
              } catch {
                setActiveEdits((prev) =>
                  prev.map((e) => (e.id === edit.id ? { ...e, uploading: false } : e)),
                );
              }
            } else {
              setActiveEdits((prev) =>
                prev.map((e) =>
                  e.id === edit.id ? { ...e, pendingUpload: true, lastMtime: currentMtime } : e,
                ),
              );
            }
          }
        } catch {
          // Temp file deleted — remove tracking
          setActiveEdits((prev) => prev.filter((e) => e.id !== edit.id));
        }
      }
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEdits, sftpId]);

  // Clear active edits when SFTP session changes
  useEffect(() => {
    setActiveEdits([]);
  }, [sftpId]);

  const handleUpload = async () => {
    if (!sftpId) return;
    const file = await open({ multiple: false });
    if (!file) return;
    overwriteAllRef.current = "none";
    const localPath = typeof file === "string" ? file : String(file);
    await doUpload(localPath, cwd);
  };

  const handleMove = useCallback(
    async (sourcePath: string, targetDir: string) => {
      if (!sftpId) return;
      const name = sourcePath.split("/").pop() ?? "";
      const dest = joinPath(targetDir, name);
      if (sourcePath === dest) return;
      try {
        await sftpApi.rename(sftpId, sourcePath, dest);
        refresh();
      } catch (e) {
        alert(errMsg(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sftpId, cwd],
  );

  // ── Tauri native drag-drop (OS → app) ──────────────────────────────────────
  //
  // NB: `onDragDropEvent` returns a Promise<UnlistenFn>. The handler is
  // registered synchronously in Rust, but the unlisten fn only arrives after
  // the IPC round-trip. If the effect's cleanup runs before `.then` resolves,
  // the stored `unlisten` is still null and the listener leaks — on the next
  // registration we end up with *two* handlers, so a single OS drop fires
  // `doUpload` twice (or more). To avoid this:
  //   1. Keep volatile values (`cwd`, `dropTargetPath`, `doUpload`) in refs so
  //      this effect only re-runs when `sftpId` truly changes.
  //   2. Guard with a `cancelled` flag: if cleanup fires before the unlisten
  //      is available, invoke it as soon as it arrives.

  const cwdRef = useRef(cwd);
  const dropTargetPathRef = useRef(dropTargetPath);
  const doUploadRef = useRef(doUpload);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);
  useEffect(() => { dropTargetPathRef.current = dropTargetPath; }, [dropTargetPath]);
  useEffect(() => { doUploadRef.current = doUpload; }, [doUpload]);

  useEffect(() => {
    if (!sftpId) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        switch (event.payload.type) {
          case "enter":
            setOsDragOver(true);
            break;
          case "over":
            break;
          case "drop": {
            setOsDragOver(false);
            // Reset "for all" preference for each new drop batch
            overwriteAllRef.current = "none";
            const paths = event.payload.paths;
            if (paths.length > 0) {
              const target = dropTargetPathRef.current ?? cwdRef.current;
              for (const p of paths) {
                void doUploadRef.current(p, target);
              }
            }
            setDropTargetPath(null);
            break;
          }
          case "leave":
            setOsDragOver(false);
            setDropTargetPath(null);
            break;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sftpId]);

  // ── Drag-out (app → OS) via tauri-plugin-drag ──────────────────────────────

  const handleDragOut = useCallback(
    async (entry: RemoteEntry) => {
      if (!sftpId || entry.isDir) return;
      try {
        // Download to temp
        const tempPath = await sftpApi.downloadTemp(
          sftpId,
          entry.path,
          entry.name,
        );
        // Call the drag plugin's IPC command directly
        const ch = new Channel<unknown>(() => {});
        await invoke("plugin:drag|start_drag", {
          item: [tempPath],
          image: DRAG_ICON,
          onEvent: ch,
        });
      } catch (e) {
        // Drag cancelled or failed — ignore silently
        console.debug("drag-out:", e);
      }
    },
    [sftpId],
  );

  // ── Internal drag handlers (remote entry → folder) ─────────────────────────

  const onDragStart = (e: React.DragEvent, entry: RemoteEntry) => {
    if (!entry.isDir) {
      // For files — try drag-out to OS
      e.preventDefault();
      void handleDragOut(entry);
      return;
    }
    // For directories — internal move only
    e.dataTransfer.setData(DRAG_MIME, entry.path);
    e.dataTransfer.effectAllowed = "move";
    setDraggingEntry(entry.path);
  };

  const onDragEnd = () => {
    setDraggingEntry(null);
    setDropTargetPath(null);
  };

  const onDirDragOver = (e: React.DragEvent, dirPath: string) => {
    if (
      e.dataTransfer.types.includes(DRAG_MIME) ||
      e.dataTransfer.types.includes("Files")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTargetPath(dirPath);
    }
  };

  const onDirDragLeave = (_e: React.DragEvent, dirPath: string) => {
    if (dropTargetPath === dirPath) setDropTargetPath(null);
  };

  const onDirDrop = (e: React.DragEvent, dirPath: string) => {
    e.preventDefault();
    setDropTargetPath(null);
    const sourcePath = e.dataTransfer.getData(DRAG_MIME);
    if (sourcePath) void handleMove(sourcePath, dirPath);
  };

  const onListDragOver = (e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes(DRAG_MIME) ||
      e.dataTransfer.types.includes("Files")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const onListDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const sourcePath = e.dataTransfer.getData(DRAG_MIME);
    if (sourcePath) void handleMove(sourcePath, cwd);
  };

  // ── Early returns ───────────────────────────────────────────────────────────

  if (!sessionId) {
    return (
      <div
        id="files-browser"
        className="flex h-full items-center justify-center p-4 text-center text-xs text-fg-muted"
      >
        {t("files.noSession")}
      </div>
    );
  }

  if (connecting) {
    return (
      <div
        id="files-browser"
        className="flex h-full items-center justify-center gap-2 text-xs text-fg-muted"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("files.connecting")}
      </div>
    );
  }

  if (error && !sftpId) {
    return (
      <div id="files-browser" className="flex flex-col items-center gap-3 p-4">
        <div className="text-center text-xs text-danger">{localizeError(error, t)}</div>
        <button
          type="button"
          onClick={() => {
            // Reset state so the useEffect re-triggers SFTP connect
            sftpForSession.current = null;
            setError(null);
            setConnecting(false);
            setSftpId(null);
            // Force re-run by toggling a dummy state — the sessionId
            // useEffect will see sftpForSession.current !== sessionId
            setEntries([]);
          }}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-[11px] text-fg-muted hover:bg-bg-overlay hover:text-fg"
        >
          <RefreshCw className="h-3 w-3" />
          {t("files.refresh")}
        </button>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
    <Tooltip.Provider delayDuration={400} skipDelayDuration={150}>
      <div
        id="files-browser"
        tabIndex={-1}
        className={cn(
          "flex h-full flex-col transition-colors outline-none",
          osDragOver && "bg-accent/5",
        )}
      >
        {/* Toolbar — navigation + editable path */}
        <div className="flex items-center gap-0.5 border-b border-border-subtle px-1.5 py-1.5">
          <button
            type="button"
            onClick={goBack}
            disabled={!canGoBack}
            className="rounded p-1 text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:opacity-30"
            title={t("files.goBack")}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={goForward}
            disabled={!canGoForward}
            className="rounded p-1 text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:opacity-30"
            title={t("files.goForward")}
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <input
            type="text"
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitPathDraft();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setPathDraft(cwd);
                e.currentTarget.blur();
              }
            }}
            onBlur={() => setPathDraft(cwd)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            title={cwd}
            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-fg-muted outline-none hover:border-border-subtle focus:border-accent focus:bg-bg-elevated focus:text-fg"
          />
          <button
            type="button"
            onClick={refresh}
            className="rounded p-1 text-fg-muted hover:bg-bg-overlay hover:text-fg"
            title={t("files.refresh")}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </button>
          <button
            type="button"
            onClick={openSftpTab}
            disabled={!sessionId}
            className="rounded p-1 text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:opacity-30"
            title={t("files.openInTab")}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Action buttons — parent dir, upload, mkdir, touch */}
        <div className="flex items-center gap-0.5 border-b border-border-subtle px-1.5 py-1">
          <button
            type="button"
            onClick={goUp}
            disabled={cwd === "/"}
            className="rounded p-1.5 text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:opacity-30"
            title={t("files.goUp")}
          >
            <FolderUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleUpload()}
            className="rounded p-1.5 text-fg-muted hover:bg-bg-overlay hover:text-fg"
            title={t("files.upload")}
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleMkdir()}
            className="rounded p-1.5 text-fg-muted hover:bg-bg-overlay hover:text-fg"
            title={t("files.newDir")}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleTouch()}
            className="rounded p-1.5 text-fg-muted hover:bg-bg-overlay hover:text-fg"
            title={t("files.newFile")}
          >
            <FilePlus className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Overwrite confirmation prompt */}
        {overwritePrompt && (
          <div className="border-b border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
            <p className="text-[11px] text-fg">
              {t("files.overwritePrompt", { name: overwritePrompt.fileName })}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => handleOverwriteAnswer("yes")}
                className="rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-white hover:bg-accent/90"
              >
                {t("files.overwriteYes")}
              </button>
              <button
                type="button"
                onClick={() => handleOverwriteAnswer("no")}
                className="rounded bg-fg-muted/20 px-2 py-0.5 text-[10px] font-medium text-fg hover:bg-fg-muted/30"
              >
                {t("files.overwriteNo")}
              </button>
              <button
                type="button"
                onClick={() => handleOverwriteAnswer("yesAll")}
                className="rounded bg-accent/70 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-accent/60"
              >
                {t("files.overwriteYesAll")}
              </button>
              <button
                type="button"
                onClick={() => handleOverwriteAnswer("noAll")}
                className="rounded bg-fg-muted/20 px-2 py-0.5 text-[10px] font-medium text-fg hover:bg-fg-muted/30"
              >
                {t("files.overwriteNoAll")}
              </button>
            </div>
            {overwriteQueue.length > 0 && (
              <p className="mt-1 text-[9px] text-fg-subtle">
                +{overwriteQueue.length} {t("files.overwritePending")}
              </p>
            )}
          </div>
        )}

        {/* OS drag overlay hint */}
        {osDragOver && (
          <div className="flex items-center justify-center gap-1.5 border-b border-accent/30 bg-accent/10 px-2 py-2 text-[11px] text-accent">
            <Upload className="h-3.5 w-3.5" />
            {t("files.dropToUpload")}
          </div>
        )}

        {/* Active edits indicator */}
        {activeEdits.length > 0 && (
          <div className="border-b border-border-subtle">
            {activeEdits.map((edit) => (
              <div key={edit.id} className="px-2 py-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <ExternalLink className="h-3 w-3 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {edit.fileName}
                  </span>
                  {edit.uploading && (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" />
                  )}
                  {!edit.uploading && !edit.pendingUpload && (
                    <span className="shrink-0 text-[10px] text-fg-muted">
                      {edit.autoUpload ? t("files.editAuto") : t("files.editWatching")}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => dismissEdit(edit.id)}
                    className="shrink-0 rounded p-0.5 text-fg-subtle hover:text-fg"
                    title={t("files.editDismiss")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {/* Upload confirmation buttons */}
                {edit.pendingUpload && (
                  <div className="mt-1 flex items-center gap-1">
                    <span className="text-[10px] text-warning">{t("files.editModified")}</span>
                    <div className="ml-auto flex gap-1">
                      <button
                        type="button"
                        onClick={() => void doEditUpload(edit.id)}
                        className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-accent/90"
                      >
                        {t("files.editUpload")}
                      </button>
                      <button
                        type="button"
                        onClick={() => skipEditUpload(edit.id)}
                        className="rounded bg-fg-muted/20 px-1.5 py-0.5 text-[10px] font-medium text-fg hover:bg-fg-muted/30"
                      >
                        {t("files.editSkip")}
                      </button>
                      <button
                        type="button"
                        onClick={() => enableAutoUpload(edit.id)}
                        className="rounded bg-success/80 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-success/70"
                      >
                        {t("files.editAutoUpload")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* File list */}
        <div
          className="min-h-0 flex-1 overflow-y-auto py-0.5"
          onDragOver={onListDragOver}
          onDrop={onListDrop}
        >
          {entries.map((entry) => {
            const isDragSource = draggingEntry === entry.path;
            const isDropTarget =
              dropTargetPath === entry.path && entry.isDir;

            return (
              <Tooltip.Root key={entry.path}>
                <ContextMenu.Root>
                  <ContextMenu.Trigger asChild>
                    <Tooltip.Trigger asChild>
                      <div
                        role="button"
                        tabIndex={0}
                        draggable
                        onDragStart={(e) => onDragStart(e, entry)}
                        onDragEnd={onDragEnd}
                        onDragOver={
                          entry.isDir
                            ? (e) => onDirDragOver(e, entry.path)
                            : undefined
                        }
                        onDragLeave={
                          entry.isDir
                            ? (e) => onDirDragLeave(e, entry.path)
                            : undefined
                        }
                        onDrop={
                          entry.isDir
                            ? (e) => onDirDrop(e, entry.path)
                            : undefined
                        }
                        className={cn(
                          "group flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs",
                          "hover:bg-bg-overlay",
                          isDragSource && "opacity-40",
                          deletingPath === entry.path && "pointer-events-none opacity-40",
                          isDropTarget &&
                            "rounded-sm bg-accent/15 ring-1 ring-accent/40",
                        )}
                        onClick={() => {
                          if (entry.isDir) navigateTo(entry.path);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && entry.isDir)
                            navigateTo(entry.path);
                        }}
                      >
                        {deletingPath === entry.path ? (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-subtle" />
                        ) : entry.isDir ? (
                          <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                        ) : (
                          <File className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-fg">
                          {entry.name}
                        </span>
                        {!entry.isDir && (
                          <span className="shrink-0 text-[10px] tabular-nums text-fg-subtle">
                            {formatSize(entry.size)}
                          </span>
                        )}
                      </div>
                    </Tooltip.Trigger>
                  </ContextMenu.Trigger>
                  <ContextMenu.Portal>
                    <ContextMenu.Content className="z-50 min-w-[160px] rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-xl">
                      {!entry.isDir && (
                        <ContextMenu.Item
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
                          onSelect={() => void handleDownload(entry)}
                        >
                          <Download className="h-3.5 w-3.5" />
                          {t("files.download")}
                        </ContextMenu.Item>
                      )}
                      {!entry.isDir && (
                        <ContextMenu.Item
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
                          onSelect={() => void handleEditFile(entry)}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t("files.editInEditor")}
                        </ContextMenu.Item>
                      )}
                      {entry.isDir && (
                        <ContextMenu.Item
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
                          onSelect={() => navigateTo(entry.path)}
                        >
                          <Folder className="h-3.5 w-3.5" />
                          {t("files.openDir")}
                        </ContextMenu.Item>
                      )}
                      <ContextMenu.Item
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
                        onSelect={() => void handleRename(entry)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        {t("files.rename")}
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
                        onSelect={() => {
                          setCopyEntries([entry]);
                          setCopyDialogOpen(true);
                        }}
                      >
                        <Send className="h-3.5 w-3.5" />
                        {t("files.copyToServer")}
                      </ContextMenu.Item>
                      <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
                      <ContextMenu.Item
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-danger outline-none hover:bg-danger/10"
                        onSelect={() => void handleDelete(entry)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("files.delete")}
                      </ContextMenu.Item>
                    </ContextMenu.Content>
                  </ContextMenu.Portal>
                </ContextMenu.Root>
                <Tooltip.Portal>
                  <Tooltip.Content
                    side="right"
                    sideOffset={8}
                    className="z-50 max-w-xs whitespace-pre-wrap rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-xl"
                  >
                    {entryTooltip(entry)}
                    <Tooltip.Arrow className="fill-bg-elevated" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            );
          })}
          {entries.length === 0 && !loading && (
            <div className="px-3 py-4 text-center text-[11px] text-fg-muted">
              {t("files.empty")}
            </div>
          )}
        </div>
      </div>
    </Tooltip.Provider>

    {/* Copy to server dialog */}
    {sftpId && sessionId && (
      <CopyToServerDialog
        open={copyDialogOpen}
        onOpenChange={setCopyDialogOpen}
        srcRuntimeId={sftpId}
        srcSessionId={sessionId}
        entries={copyEntries}
      />
    )}
    </>
  );
}
