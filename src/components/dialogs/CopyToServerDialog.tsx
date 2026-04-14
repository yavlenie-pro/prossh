/**
 * Dialog for copying files/directories between remote servers via SCP.
 *
 * Multi-step wizard:
 * 1. Pick destination session + browse its FS to choose target path
 * 2. On "Copy" — run prerequisite checks/installs, then execute `scp` on
 *    the source server targeting the destination directly.
 *
 * Steps executed automatically with confirmation prompts:
 *  - check `which scp` on source (install if missing, with confirmation)
 *  - check SSH key on source (generate if missing, with confirmation)
 *  - authorize source's pubkey on destination's authorized_keys
 *  - run `scp -r -P <port> -o StrictHostKeyChecking=no <path> user@host:<dst>`
 */
import { useEffect, useRef, useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  File,
  Folder,
  FolderUp,
  Loader2,
  Minimize2,
  Search,
  Server,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { RemoteEntry } from "@/api/sftp";
import { sftpApi } from "@/api/sftp";
import type { Session } from "@/api/types";
import { cn } from "@/lib/cn";
import { useSessionsStore } from "@/stores/sessions";
import { useTransfersStore } from "@/stores/transfers";

/** Extract readable message from Tauri invoke errors ({kind,message} objects). */
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

/* ---------- Types ---------- */

type StepStatus = "pending" | "running" | "done" | "failed" | "confirm";

interface WizardStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  /** When status=confirm, what buttons to show */
  confirmLabel?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** SFTP runtime id of the source session (already connected). */
  srcRuntimeId: string;
  /** Source session id (to exclude from the destination picker). */
  srcSessionId: string;
  /** Files/dirs to copy. */
  entries: RemoteEntry[];
}

/* ---------- Component ---------- */

export function CopyToServerDialog({
  open,
  onOpenChange,
  srcRuntimeId,
  srcSessionId,
  entries,
}: Props) {
  const { t } = useTranslation();
  const sessions = useSessionsStore((s) => s.sessions);
  const load = useSessionsStore((s) => s.load);

  /* ---- Session picker state ---- */
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [dstRuntimeId, setDstRuntimeId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  /* ---- Destination browser state ---- */
  const [cwd, setCwd] = useState("/");
  const [dirEntries, setDirEntries] = useState<RemoteEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);

  /* ---- Wizard state ---- */
  const [wizardActive, setWizardActive] = useState(false);
  const [steps, setSteps] = useState<WizardStep[]>([]);
  const [wizardDone, setWizardDone] = useState(false);
  const [cleanupKey, setCleanupKey] = useState(true);
  /** Used to wait for user confirmation in wizard steps */
  const confirmResolveRef = useRef<((yes: boolean) => void) | null>(null);
  /** Transfer queue ID for minimize-to-queue */
  const scpTransferIdRef = useRef<string | null>(null);
  const dstRuntimeRef = useRef<string | null>(null);

  const srcSession = sessions.find((s) => s.id === srcSessionId);
  const otherSessions = sessions.filter((s) => s.id !== srcSessionId);
  const selectedSession = otherSessions.find((s) => s.id === selectedSessionId) ?? null;

  const pickerQuery = pickerSearch.trim().toLowerCase();
  const filteredSessions = pickerQuery
    ? otherSessions.filter(
        (s) =>
          s.name.toLowerCase().includes(pickerQuery) ||
          s.host.toLowerCase().includes(pickerQuery) ||
          s.username.toLowerCase().includes(pickerQuery),
      )
    : otherSessions;

  useEffect(() => {
    void load();
  }, [load]);

  // Reset on open/close
  useEffect(() => {
    if (open) {
      setSelectedSessionId(null);
      setDstRuntimeId(null);
      setConnecting(false);
      setConnectError(null);
      setPickerOpen(false);
      setPickerSearch("");
      setCwd("/");
      setDirEntries([]);
      setWizardActive(false);
      setWizardDone(false);
      setCleanupKey(true);
      setSteps([]);
      confirmResolveRef.current = null;
    } else {
      if (dstRuntimeRef.current) {
        void sftpApi.close(dstRuntimeRef.current);
        dstRuntimeRef.current = null;
      }
    }
  }, [open]);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  // Focus search when picker opens
  useEffect(() => {
    if (pickerOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    } else {
      setPickerSearch("");
    }
  }, [pickerOpen]);

  /* ---- Session picker ---- */
  const handleSelectSession = async (session: Session) => {
    setPickerOpen(false);
    setPickerSearch("");

    if (dstRuntimeRef.current) {
      void sftpApi.close(dstRuntimeRef.current);
      dstRuntimeRef.current = null;
      setDstRuntimeId(null);
    }

    setSelectedSessionId(session.id);
    setConnecting(true);
    setConnectError(null);
    setDirEntries([]);
    setCwd("/");

    try {
      const rid = await sftpApi.open(session.id);
      dstRuntimeRef.current = rid;
      setDstRuntimeId(rid);
      const list = await sftpApi.list(rid, "/");
      setDirEntries(list);
      setCwd("/");
    } catch (e: unknown) {
      setConnectError(errMsg(e));
    } finally {
      setConnecting(false);
    }
  };

  /* ---- Destination browser ---- */
  const navigateTo = async (path: string) => {
    if (!dstRuntimeId) return;
    setLoadingDir(true);
    try {
      const list = await sftpApi.list(dstRuntimeId, path);
      setDirEntries(list);
      setCwd(path);
    } catch {
      /* stay on current dir */
    } finally {
      setLoadingDir(false);
    }
  };

  const navigateUp = () => {
    if (cwd === "/") return;
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    void navigateTo(parts.length === 0 ? "/" : "/" + parts.join("/"));
  };

  /* ---------- Wizard helpers ---------- */

  const updateStep = useCallback(
    (id: string, patch: Partial<WizardStep>) => {
      setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    },
    [],
  );

  /** Pause and wait for user to click Confirm/Skip in a specific step. */
  const waitForConfirm = useCallback((): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      confirmResolveRef.current = resolve;
    });
  }, []);

  const handleConfirm = (yes: boolean) => {
    if (confirmResolveRef.current) {
      confirmResolveRef.current(yes);
      confirmResolveRef.current = null;
    }
  };

  /* ---------- Server-to-server copy wizard ---------- */

  const runWizard = async () => {
    if (!dstRuntimeId || !selectedSession || entries.length === 0) return;

    setWizardActive(true);
    setWizardDone(false);

    const shouldCleanup = cleanupKey;
    const initialSteps: WizardStep[] = [
      { id: "check-tool", label: t("files.scpCheckingScp"), status: "pending" },
      { id: "upload-cred", label: t("files.scpAuthorizingKey"), status: "pending" },
      { id: "copy-run", label: t("files.scpStarting"), status: "pending" },
      ...(shouldCleanup
        ? [{ id: "cleanup", label: t("files.scpCleaningUp"), status: "pending" as StepStatus }]
        : []),
    ];
    setSteps(initialSteps);

    const dst = selectedSession;
    const srcRid = srcRuntimeId;
    const tmpId = Math.random().toString(36).slice(2, 10);
    /** Path to temp credential on source — set by step 2. */
    let credRemotePath = "";
    let authMethod = "key";
    let needsSshpass = false;

    try {
      /* ---- Step 1: Check rsync / scp (and sshpass if needed) on source ---- */
      updateStep("check-tool", { status: "running" });

      // Prefer rsync, fall back to scp
      const rsyncCheck = await sftpApi.remoteExec(srcRid, "command -v rsync 2>/dev/null", 10);
      let useRsync = rsyncCheck.exitCode === 0 && rsyncCheck.stdout.trim().length > 0;
      let hasTool = useRsync;

      if (!useRsync) {
        const scpCheck = await sftpApi.remoteExec(srcRid, "command -v scp 2>/dev/null", 10);
        hasTool = scpCheck.exitCode === 0 && scpCheck.stdout.trim().length > 0;
      }

      if (!hasTool) {
        const pmCheck = await sftpApi.remoteExec(
          srcRid,
          "if command -v apt-get >/dev/null 2>&1; then echo apt; elif command -v dnf >/dev/null 2>&1; then echo dnf; elif command -v yum >/dev/null 2>&1; then echo yum; elif command -v apk >/dev/null 2>&1; then echo apk; elif command -v pacman >/dev/null 2>&1; then echo pacman; elif command -v zypper >/dev/null 2>&1; then echo zypper; else echo unknown; fi",
          10,
        );
        const pm = pmCheck.stdout.trim();
        const rsyncPkg = pm === "apk" ? "rsync openssh-client" : "rsync";
        let installCmd: string;
        switch (pm) {
          case "apt":    installCmd = `apt-get update -qq && apt-get install -y ${rsyncPkg}`; break;
          case "yum":    installCmd = `yum install -y ${rsyncPkg}`; break;
          case "dnf":    installCmd = `dnf install -y ${rsyncPkg}`; break;
          case "apk":    installCmd = `apk add --no-cache ${rsyncPkg}`; break;
          case "pacman": installCmd = `pacman -S --noconfirm ${rsyncPkg}`; break;
          case "zypper": installCmd = `zypper install -y ${rsyncPkg}`; break;
          default:       installCmd = `apt-get install -y ${rsyncPkg}`;
        }

        updateStep("check-tool", {
          status: "confirm",
          label: t("files.scpNotFound"),
          detail: t("files.scpInstallPrompt", { command: installCmd }),
          confirmLabel: t("files.scpConfirmInstall"),
        });
        const userSaid = await waitForConfirm();
        if (!userSaid) {
          updateStep("check-tool", { status: "failed", detail: t("files.scpSkip") });
          setWizardDone(true);
          return;
        }
        updateStep("check-tool", { status: "running", label: t("files.scpInstalling") });
        await sftpApi.remoteExec(srcRid, installCmd, 120);
        const vr = await sftpApi.remoteExec(srcRid, "command -v rsync 2>/dev/null", 5);
        if (vr.exitCode === 0 && vr.stdout.trim()) useRsync = true;
        else {
          const vs = await sftpApi.remoteExec(srcRid, "command -v scp 2>/dev/null", 5);
          if (vs.exitCode !== 0 || !vs.stdout.trim()) {
            updateStep("check-tool", { status: "failed", label: t("files.scpInstallFailed", { error: "rsync/scp not found" }) });
            setWizardDone(true);
            return;
          }
        }
        updateStep("check-tool", { status: "done", label: t("files.scpInstalled") });
      } else {
        updateStep("check-tool", {
          status: "done",
          label: (useRsync ? "rsync" : "scp") + " " + t("files.scpFound").toLowerCase(),
        });
      }

      /* ---- Step 2: Upload destination's real credentials to source ---- */
      // The Rust backend reads the private key (key auth) or password (password
      // auth) from the local machine / OS keychain and writes it to a temp file
      // on the source server via SFTP. Secrets never touch the frontend.
      // authorized_keys is NEVER modified.
      updateStep("upload-cred", { status: "running" });

      let authPrep: { method: string; remotePath: string; needsSshpass: boolean };
      try {
        authPrep = await sftpApi.prepareServerCopyAuth(dst.id, srcRid, tmpId);
        credRemotePath = authPrep.remotePath;
        authMethod = authPrep.method;
        needsSshpass = authPrep.needsSshpass;
      } catch (e: unknown) {
        updateStep("upload-cred", {
          status: "failed",
          label: t("files.scpAuthFailed", {
            error: errMsg(e),
          }),
        });
        setWizardDone(true);
        return;
      }

      // If password auth, check that sshpass is available on source
      if (needsSshpass) {
        const sshpassCheck = await sftpApi.remoteExec(srcRid, "command -v sshpass 2>/dev/null", 5);
        if (sshpassCheck.exitCode !== 0) {
          // Try to install sshpass
          const pmCheck = await sftpApi.remoteExec(
            srcRid,
            "if command -v apt-get >/dev/null 2>&1; then echo apt; elif command -v dnf >/dev/null 2>&1; then echo dnf; elif command -v yum >/dev/null 2>&1; then echo yum; elif command -v apk >/dev/null 2>&1; then echo apk; elif command -v pacman >/dev/null 2>&1; then echo pacman; else echo unknown; fi",
            10,
          );
          const pm = pmCheck.stdout.trim();
          let cmd: string;
          switch (pm) {
            case "apt":    cmd = "apt-get update -qq && apt-get install -y sshpass"; break;
            case "yum":    cmd = "yum install -y sshpass"; break;
            case "dnf":    cmd = "dnf install -y sshpass"; break;
            case "apk":    cmd = "apk add --no-cache sshpass"; break;
            case "pacman": cmd = "pacman -S --noconfirm sshpass"; break;
            default:       cmd = "apt-get install -y sshpass";
          }
          updateStep("upload-cred", {
            status: "confirm",
            label: "sshpass " + t("files.scpNotFound").toLowerCase(),
            detail: t("files.scpInstallPrompt", { command: cmd }),
            confirmLabel: t("files.scpConfirmInstall"),
          });
          const ok = await waitForConfirm();
          if (!ok) {
            void sftpApi.cleanupServerCopyAuth(srcRid, credRemotePath);
            updateStep("upload-cred", { status: "failed", detail: t("files.scpSkip") });
            setWizardDone(true);
            return;
          }
          updateStep("upload-cred", { status: "running", label: t("files.scpInstalling") });
          await sftpApi.remoteExec(srcRid, cmd, 120);
          const v2 = await sftpApi.remoteExec(srcRid, "command -v sshpass 2>/dev/null", 5);
          if (v2.exitCode !== 0) {
            void sftpApi.cleanupServerCopyAuth(srcRid, credRemotePath);
            updateStep("upload-cred", { status: "failed", label: t("files.scpInstallFailed", { error: "sshpass" }) });
            setWizardDone(true);
            return;
          }
        }
      }

      updateStep("upload-cred", {
        status: "done",
        label: authMethod === "key" ? t("files.scpKeyAuthorized") : t("files.scpKeyAuthorized"),
      });

      /* ---- Step 3: Execute rsync / scp ---- */
      updateStep("copy-run", { status: "running", label: t("files.scpRunning") });

      // Check if any of the entries already exist on the destination
      // Use `ls -d` + stdout instead of exit code (more reliable over SSH)
      if (dstRuntimeId) {
        const existing: string[] = [];
        for (const entry of entries) {
          const targetPath = cwd === "/" ? `/${entry.name}` : `${cwd}/${entry.name}`;
          try {
            const check = await sftpApi.remoteExec(
              dstRuntimeId,
              `ls -d '${targetPath.replace(/'/g, "'\\''")}'  2>/dev/null && echo __EXISTS__`,
              5,
            );
            if (check.stdout.includes("__EXISTS__")) existing.push(entry.name);
          } catch {
            // If exec fails, skip the check for this entry
          }
        }
        if (existing.length > 0) {
          updateStep("copy-run", {
            status: "confirm",
            label: t("files.scpOverwritePrompt", {
              files: existing.length === 1 ? existing[0] : `${existing.length} ${t("files.file")}`,
            }),
            detail: existing.join(", "),
            confirmLabel: t("files.overwriteYes"),
          });
          const overwrite = await waitForConfirm();
          if (!overwrite) {
            if (shouldCleanup && credRemotePath) {
              void sftpApi.cleanupServerCopyAuth(srcRid, credRemotePath);
            }
            updateStep("copy-run", { status: "failed", detail: t("dialog.cancel") });
            setWizardDone(true);
            return;
          }
          updateStep("copy-run", { status: "running", label: t("files.scpRunning") });
          // Delete conflicting entries on destination before copying
          for (const name of existing) {
            const targetPath = cwd === "/" ? `/${name}` : `${cwd}/${name}`;
            const rmCmd = `rm -rf '${targetPath.replace(/'/g, "'\\''")}'`;
            await sftpApi.remoteExec(dstRuntimeId, rmCmd, 30);
          }
        }
      }

      const transferId = crypto.randomUUID();
      scpTransferIdRef.current = transferId;
      const fileLabel = entries.length === 1 ? entries[0].name : `${entries.length} files`;
      const { addTransfer, updateProgress, markDone, markError } = useTransfersStore.getState();
      // Use 0 as initial total — rsync will report the real total via progress2
      const srcName = srcSession?.name ?? "?";
      addTransfer(transferId, `${useRsync ? "rsync" : "SCP"}: ${fileLabel} — ${srcName} \u2192 ${dst.name}`, "scp", 0);

      const srcPaths = entries.map((e) => `'${e.path.replace(/'/g, "'\\''")}'`).join(" ");
      const dstDir = cwd === "/" ? "/" : cwd;
      const sshOpts = [
        authMethod === "key" ? `-i ${credRemotePath}` : "",
        "-o StrictHostKeyChecking=no",
        "-o UserKnownHostsFile=/dev/null",
        "-o LogLevel=ERROR",
        "-o ConnectTimeout=15",
        // BatchMode prevents SSH from hanging on interactive prompts
        // (only for key auth — sshpass needs interactive password prompt)
        authMethod === "key" ? "-o BatchMode=yes" : "",
      ].filter(Boolean).join(" ");

      let copyCmd: string;
      const sshpassPrefix = needsSshpass ? `sshpass -f ${credRemotePath} ` : "";

      if (useRsync) {
        // --no-inc-recursive: scan all files first so progress2 knows total
        // --info=progress2: overall progress (not per-file)
        copyCmd = `${sshpassPrefix}rsync -ar --no-inc-recursive --info=progress2 -e "ssh -p ${dst.port} ${sshOpts}" ${srcPaths} '${dst.username}@${dst.host}:${dstDir.replace(/'/g, "'\\''")}'`;
      } else {
        copyCmd = `${sshpassPrefix}scp -r ${sshOpts} -P ${dst.port} ${srcPaths} '${dst.username}@${dst.host}:${dstDir.replace(/'/g, "'\\''")}'`;
      }

      // rsync --info=progress2 outputs lines like (separated by \r):
      //   "  1,234,567  45%   12.34MB/s  0:01:23"
      // Parse actual bytes transferred + percentage to calculate real total.
      // Bytes may have commas: "1,234,567" → strip commas before parseInt.
      const rsyncFullRe = /([\d,]+)\s+(\d+)%\s+([\d.]+\S+\/s)/;
      const rsyncPctRe = /([\d,]+)\s+(\d+)%/;
      let lastParsedPct = -1;
      let realTotal = 0;
      let collectedStderr = "";

      const copyResult = await sftpApi.remoteExecStream(
        srcRid,
        copyCmd,
        (chunk) => {
          if (chunk.stderr) {
            collectedStderr += chunk.stderr;
            const trimmed = collectedStderr.trim();
            if (trimmed) {
              updateStep("copy-run", {
                status: "running",
                label: t("files.scpRunning"),
                detail: trimmed.slice(-200),
              });
            }
          }
          if (chunk.stdout) {
            const lines = chunk.stdout.split(/[\r\n]+/);
            for (const line of lines) {
              const fullMatch = rsyncFullRe.exec(line);
              const pctMatch = fullMatch || rsyncPctRe.exec(line);
              if (pctMatch) {
                const bytesTransferred = parseInt(pctMatch[1].replace(/,/g, ""), 10);
                const pct = parseInt(pctMatch[2], 10);
                if (pct !== lastParsedPct && pct > 0 && pct <= 100) {
                  lastParsedPct = pct;
                  // Calculate real total from bytes and percentage
                  const estimatedTotal = Math.round(bytesTransferred / (pct / 100));
                  if (estimatedTotal > realTotal) realTotal = estimatedTotal;
                  // Parse rsync speed string (e.g. "814.56MB/s") into bytes/sec
                  let rsyncSpeed: number | undefined;
                  const speedStr = fullMatch ? fullMatch[3] : "";
                  if (speedStr) {
                    const sm = /^([\d.]+)\s*(B|kB|MB|GB|TB)\/s$/i.exec(speedStr);
                    if (sm) {
                      const v = parseFloat(sm[1]);
                      const u = sm[2].toUpperCase();
                      const mul = u === "B" ? 1 : u === "KB" ? 1e3 : u === "MB" ? 1e6 : u === "GB" ? 1e9 : 1e12;
                      rsyncSpeed = v * mul;
                    }
                  }
                  updateProgress(transferId, bytesTransferred, realTotal, rsyncSpeed);
                  updateStep("copy-run", {
                    status: "running",
                    label: `${t("files.scpRunning")} ${pct}%${speedStr ? `  ${speedStr}` : ""}`,
                  });
                }
              }
            }
          }
        },
        3600,
        transferId,
      );

      if (copyResult.exitCode !== 0) {
        const errText = (copyResult.stderr || collectedStderr).trim() || "non-zero exit";
        updateStep("copy-run", { status: "failed", label: t("files.scpFailed", { error: errText }) });
        markError(transferId, errText);
      } else {
        updateStep("copy-run", { status: "done", label: t("files.scpDone") });
        markDone(transferId);
      }

      /* ---- Step 4: Cleanup — delete temp credential file from source ---- */
      if (shouldCleanup && credRemotePath) {
        updateStep("cleanup", { status: "running" });
        try {
          await sftpApi.cleanupServerCopyAuth(srcRid, credRemotePath);
          updateStep("cleanup", { status: "done", label: t("files.scpCleanedUp") });
        } catch (cleanupErr: unknown) {
          updateStep("cleanup", {
            status: "failed",
            label: t("files.scpCleanupFailed", {
              error: errMsg(cleanupErr),
            }),
          });
        }
      } else if (credRemotePath) {
        void sftpApi.cleanupServerCopyAuth(srcRid, credRemotePath);
      }
    } catch (e: unknown) {
      const msg = errMsg(e);
      const isCancelled = msg.toLowerCase().includes("cancelled");
      if (isCancelled && scpTransferIdRef.current) {
        useTransfersStore.getState().markCancelled(scpTransferIdRef.current);
      }
      // Mark the first running step as failed
      setSteps((prev) => {
        const running = prev.find((s) => s.status === "running");
        if (running) {
          return prev.map((s) =>
            s.id === running.id
              ? { ...s, status: (isCancelled ? "failed" : "failed") as StepStatus, detail: isCancelled ? t("files.transferCancelled") : msg }
              : s,
          );
        }
        return prev;
      });
    } finally {
      setWizardDone(true);
    }
  };

  /* ---------- Render ---------- */

  const pathParts = cwd === "/" ? [] : cwd.split("/").filter(Boolean);

  const allStepsDone = steps.length > 0 && steps.every((s) => s.status === "done");
  const anyFailed = steps.some((s) => s.status === "failed");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(560px,85vh)] w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl focus:outline-none">
          <Dialog.Title className="sr-only">{t("files.copyToServerTitle")}</Dialog.Title>
          <Dialog.Description className="sr-only">{t("files.copyToServerTitle")}</Dialog.Description>

          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <h2 className="text-sm font-semibold text-fg">{t("files.copyToServerTitle")}</h2>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-1 text-fg-muted hover:bg-bg-overlay hover:text-fg">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          {/* Source info */}
          <div className="border-b border-border-subtle px-4 py-2">
            <div className="text-[11px] text-fg-muted">
              {entries.length === 1
                ? entries[0].name
                : `${entries.length} ${entries.length === 1 ? "file" : "files"}`}
            </div>
          </div>

          {!wizardActive ? (
            /* ========== Phase 1: Session picker + browser ========== */
            <>
              {/* Session picker */}
              <div className="relative border-b border-border-subtle px-4 py-2.5" ref={pickerRef}>
                <label className="mb-1.5 block text-[11px] font-medium text-fg-muted">
                  {t("files.selectDestSession")}
                </label>
                {otherSessions.length === 0 ? (
                  <div className="text-xs text-fg-muted">{t("files.noOtherSessions")}</div>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={connecting}
                      onClick={() => setPickerOpen((v) => !v)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors",
                        pickerOpen ? "border-accent" : "border-border-subtle",
                        "hover:border-fg-subtle",
                        connecting && "opacity-50",
                      )}
                    >
                      <Server className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                      {selectedSession ? (
                        <div className="min-w-0 flex-1">
                          <span className="text-fg">{selectedSession.name}</span>
                          <span className="ml-1.5 text-fg-subtle">
                            {selectedSession.username}@{selectedSession.host}
                          </span>
                        </div>
                      ) : (
                        <span className="flex-1 text-fg-subtle">{t("files.selectSession")}</span>
                      )}
                      {connecting ? (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-fg-subtle" />
                      ) : (
                        <ChevronDown
                          className={cn(
                            "h-3 w-3 shrink-0 text-fg-subtle transition-transform",
                            pickerOpen && "rotate-180",
                          )}
                        />
                      )}
                    </button>

                    {pickerOpen && (
                      <div className="absolute left-4 right-4 top-full z-10 mt-1 overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated shadow-xl">
                        <div className="relative border-b border-border-subtle px-2 py-1.5">
                          <Search className="absolute left-3.5 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-subtle" />
                          <input
                            ref={searchInputRef}
                            type="text"
                            value={pickerSearch}
                            onChange={(e) => setPickerSearch(e.target.value)}
                            placeholder={t("sidebar.searchPlaceholder")}
                            className="w-full rounded border-0 bg-transparent py-0.5 pl-5 pr-1 text-xs text-fg placeholder:text-fg-subtle outline-none"
                            onKeyDown={(e) => {
                              if (e.key === "Escape") setPickerOpen(false);
                              if (e.key === "Enter" && filteredSessions.length === 1) {
                                void handleSelectSession(filteredSessions[0]);
                              }
                            }}
                          />
                        </div>
                        <div className="max-h-[200px] overflow-y-auto py-0.5">
                          {filteredSessions.length === 0 && (
                            <div className="px-3 py-3 text-center text-[11px] text-fg-muted">
                              {t("palette.noResults")}
                            </div>
                          )}
                          {filteredSessions.map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => void handleSelectSession(s)}
                              className={cn(
                                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-bg-overlay",
                                s.id === selectedSessionId && "bg-accent/10",
                              )}
                            >
                              <Server className="h-3 w-3 shrink-0 text-fg-subtle" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-fg">{s.name}</div>
                                <div className="truncate text-[10px] text-fg-muted">
                                  {s.username}@{s.host}
                                  {s.port !== 22 ? `:${s.port}` : ""}
                                </div>
                              </div>
                              {s.id === selectedSessionId && (
                                <Check className="h-3 w-3 shrink-0 text-accent" />
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
                {connectError && (
                  <div className="mt-1.5 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-danger">
                    {connectError}
                  </div>
                )}
              </div>

              {/* Destination file browser */}
              <div className="flex min-h-0 flex-1 flex-col">
                {connecting && (
                  <div className="flex flex-1 items-center justify-center gap-2 text-xs text-fg-muted">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("files.connecting")}
                  </div>
                )}

                {!connecting && dstRuntimeId && (
                  <>
                    {/* Breadcrumb */}
                    <div className="flex items-center gap-0.5 border-b border-border-subtle px-3 py-1.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => void navigateTo("/")}
                        className="rounded px-1 py-0.5 text-fg-muted hover:bg-bg-overlay hover:text-fg"
                      >
                        /
                      </button>
                      {pathParts.map((part, i) => {
                        const fullPath = "/" + pathParts.slice(0, i + 1).join("/");
                        return (
                          <span key={fullPath} className="flex items-center gap-0.5">
                            <ChevronRight className="h-2.5 w-2.5 text-fg-subtle" />
                            <button
                              type="button"
                              onClick={() => void navigateTo(fullPath)}
                              className="rounded px-1 py-0.5 text-fg-muted hover:bg-bg-overlay hover:text-fg"
                            >
                              {part}
                            </button>
                          </span>
                        );
                      })}
                      {loadingDir && <Loader2 className="ml-1 h-3 w-3 animate-spin text-fg-subtle" />}
                    </div>

                    {/* Dir listing */}
                    <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
                      {cwd !== "/" && (
                        <button
                          type="button"
                          onClick={navigateUp}
                          className="flex w-full items-center gap-1.5 px-3 py-1 text-xs text-fg-muted hover:bg-bg-overlay"
                        >
                          <FolderUp className="h-3.5 w-3.5" />
                          ..
                        </button>
                      )}
                      {dirEntries.map((e) => (
                        <button
                          key={e.path}
                          type="button"
                          onClick={() => {
                            if (e.isDir) void navigateTo(e.path);
                          }}
                          className={cn(
                            "flex w-full items-center gap-1.5 px-3 py-1 text-xs",
                            e.isDir
                              ? "cursor-pointer text-fg hover:bg-bg-overlay"
                              : "cursor-default text-fg-muted",
                          )}
                        >
                          {e.isDir ? (
                            <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                          ) : (
                            <File className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-left">{e.name}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {!connecting && !dstRuntimeId && !connectError && (
                  <div className="flex flex-1 items-center justify-center text-xs text-fg-muted">
                    {t("files.selectSession")}
                  </div>
                )}
              </div>

              {/* Footer — phase 1 */}
              <div className="border-t border-border-subtle px-4 py-3">
                {/* Dest path + cleanup checkbox */}
                <div className="mb-2 flex items-center justify-between">
                  <div className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
                    {dstRuntimeId && (
                      <>
                        <span className="font-medium text-fg">{t("files.destPath")}:</span> {cwd}
                      </>
                    )}
                  </div>
                </div>
                {dstRuntimeId && (
                  <label className="mb-2.5 flex cursor-pointer items-center gap-2 text-[11px] text-fg-muted">
                    <input
                      type="checkbox"
                      checked={cleanupKey}
                      onChange={(e) => setCleanupKey(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-border-subtle accent-accent"
                    />
                    {t("files.scpCleanupKey")}
                  </label>
                )}
                <div className="flex items-center justify-end gap-2">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-overlay"
                    >
                      {t("dialog.cancel")}
                    </button>
                  </Dialog.Close>
                  <button
                    type="button"
                    disabled={!dstRuntimeId || entries.length === 0}
                    onClick={() => void runWizard()}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover",
                      !dstRuntimeId && "opacity-50",
                    )}
                  >
                    <ArrowRight className="h-3 w-3" />
                    {t("files.copy")}
                  </button>
                </div>
              </div>
            </>
          ) : (
            /* ========== Phase 2: SCP Wizard ========== */
            <>
              {/* Wizard subtitle */}
              <div className="border-b border-border-subtle px-4 py-2">
                <div className="flex items-center gap-2 text-[11px] text-fg-muted">
                  <Server className="h-3 w-3" />
                  <span className="font-medium text-fg">{selectedSession?.name}</span>
                  <span>
                    {selectedSession?.username}@{selectedSession?.host}
                  </span>
                  <ArrowRight className="h-2.5 w-2.5" />
                  <span className="text-fg">{cwd}</span>
                </div>
              </div>

              {/* Steps */}
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-4 py-3">
                {steps.map((step) => (
                  <div key={step.id} className="flex flex-col gap-1.5 rounded-lg border border-border-subtle px-3 py-2.5">
                    <div className="flex items-start gap-2.5">
                      {/* Status icon */}
                      <div className="mt-0.5 shrink-0">
                        {step.status === "pending" && (
                          <Circle className="h-4 w-4 text-fg-subtle" />
                        )}
                        {step.status === "running" && (
                          <Loader2 className="h-4 w-4 animate-spin text-accent" />
                        )}
                        {step.status === "done" && (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        )}
                        {step.status === "failed" && (
                          <XCircle className="h-4 w-4 text-danger" />
                        )}
                        {step.status === "confirm" && (
                          <AlertTriangle className="h-4 w-4 text-yellow-500" />
                        )}
                      </div>

                      {/* Label + detail */}
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn(
                            "text-xs",
                            step.status === "done" && "text-fg-muted",
                            step.status === "failed" && "text-danger",
                            step.status === "running" && "text-fg",
                            step.status === "confirm" && "text-fg",
                            step.status === "pending" && "text-fg-subtle",
                          )}
                        >
                          {step.label}
                        </div>
                        {step.detail && (
                          <div
                            className={cn(
                              "mt-0.5 text-[11px]",
                              step.status === "failed" ? "text-danger/80" : "text-fg-muted",
                            )}
                          >
                            {step.detail}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Confirm buttons */}
                    {step.status === "confirm" && (
                      <div className="flex items-center gap-2 pl-6">
                        <button
                          type="button"
                          onClick={() => handleConfirm(true)}
                          className="rounded-md bg-accent px-3 py-1 text-[11px] font-medium text-white hover:bg-accent-hover"
                        >
                          {step.confirmLabel ?? t("files.scpConfirmInstall")}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleConfirm(false)}
                          className="rounded-md border border-border-subtle px-3 py-1 text-[11px] text-fg-muted hover:bg-bg-overlay"
                        >
                          {t("files.scpSkip")}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Footer — phase 2 */}
              <div className="flex items-center justify-between border-t border-border-subtle px-4 py-3">
                {/* Minimize to transfer queue — available while SCP is running */}
                <div>
                  {!wizardDone && steps.some((s) => s.id === "copy-run" && s.status === "running") && (
                    <button
                      type="button"
                      onClick={() => onOpenChange(false)}
                      className="flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-[11px] text-fg-muted hover:bg-bg-overlay"
                      title={t("files.scpMinimize")}
                    >
                      <Minimize2 className="h-3 w-3" />
                      {t("files.scpMinimize")}
                    </button>
                  )}
                </div>
                <div>
                  {wizardDone && (
                    <button
                      type="button"
                      onClick={() => onOpenChange(false)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                        allStepsDone
                          ? "bg-green-600 text-white hover:bg-green-700"
                          : anyFailed
                            ? "bg-danger/90 text-white hover:bg-danger"
                            : "bg-accent text-white hover:bg-accent-hover",
                      )}
                    >
                      {allStepsDone ? (
                        <>
                          <Check className="h-3 w-3" />
                          {t("files.scpClose")}
                        </>
                      ) : (
                        <>
                          <X className="h-3 w-3" />
                          {t("files.scpClose")}
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
