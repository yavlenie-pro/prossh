/**
 * React hook that manages an xterm.js terminal instance and wires it to a live
 * SSH PTY session via Tauri IPC channels.
 *
 * Usage:
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * const { status, error, close } = useXterm(ref, session.id);
 * ```
 *
 * The hook opens the SSH connection as soon as the `ref` element mounts, and
 * tears everything down on unmount (or when the session id changes).
 */
import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

import type { PtyChunk, SshStatus } from "@/api/pty";
import { ptyApi } from "@/api/pty";
import { settingsApi } from "@/api/settings";
import { sshApi } from "@/api/ssh";
import { formatError, useSessionsStore } from "@/stores/sessions";
import { useTabsStore } from "@/stores/tabs";
import { useThemeStore } from "@/stores/theme";

export type XtermStatus = "connecting" | "authenticating" | "connected" | "disconnected" | "error";

export interface PassphrasePrompt {
  promptId: string;
  keyPath: string;
}

export interface HostKeyPrompt {
  promptId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

export interface CredentialsPrompt {
  promptId: string;
  username: string;
  reason: string;
}

export interface SelectionPopup {
  text: string;
  x: number;
  y: number;
}

interface XtermState {
  status: XtermStatus;
  error: string | null;
  disconnectReason: string | null;
  passphrasePrompt: PassphrasePrompt | null;
  clearPassphrasePrompt: () => void;
  hostKeyPrompt: HostKeyPrompt | null;
  clearHostKeyPrompt: () => void;
  credentialsPrompt: CredentialsPrompt | null;
  clearCredentialsPrompt: () => void;
  selectionPopup: SelectionPopup | null;
  clearSelectionPopup: () => void;
  close: () => void;
  reconnect: () => void;
}

export function useXterm(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string,
  paneId?: string,
): XtermState {
  const [status, setStatus] = useState<XtermStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [disconnectReason, setDisconnectReason] = useState<string | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [passphrasePrompt, setPassphrasePrompt] =
    useState<PassphrasePrompt | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt | null>(
    null,
  );
  const [credentialsPrompt, setCredentialsPrompt] =
    useState<CredentialsPrompt | null>(null);
  const [selectionPopup, setSelectionPopup] = useState<SelectionPopup | null>(null);
  const runtimeIdRef = useRef<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const clearPassphrasePrompt = () => setPassphrasePrompt(null);
  const clearHostKeyPrompt = () => setHostKeyPrompt(null);
  const clearCredentialsPrompt = () => setCredentialsPrompt(null);
  const clearSelectionPopup = () => setSelectionPopup(null);

  // Manual close callable from the parent component.
  const close = () => {
    if (runtimeIdRef.current) {
      void ptyApi.closeSession(runtimeIdRef.current);
      runtimeIdRef.current = null;
    }
  };

  const reconnect = () => {
    close();
    setStatus("connecting");
    setError(null);
    setDisconnectReason(null);
    setReconnectKey((k) => k + 1);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // --- Terminal instance ---------------------------------------------------
    const xtermTheme = useThemeStore.getState().xtermTheme();
    const term = new Terminal({
      fontFamily:
        "Cascadia Code, JetBrains Mono, Fira Code, Consolas, Menlo, monospace",
      fontSize: 14,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      convertEol: false,
      theme: xtermTheme,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon());
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL not available — fallback to canvas renderer (default)
    }

    term.open(el);

    // Add padding around terminal content so text doesn't touch edges.
    // xterm.js doesn't have a native padding option, so we style the
    // internal viewport/screen elements and account for it in fit().
    const PADDING = 8;
    const xtermEl = el.querySelector(".xterm") as HTMLElement | null;
    if (xtermEl) xtermEl.style.padding = `${PADDING}px`;

    fit.fit();
    // Auto-focus the terminal so keystrokes land immediately (e.g. after
    // opening a session from the command palette).
    term.focus();
    termRef.current = term;
    fitRef.current = fit;

    // --- Subscribe to theme changes so the terminal updates live ------------
    let prevProfileId = useThemeStore.getState().activeProfileId;
    const unsubTheme = useThemeStore.subscribe((state) => {
      if (state.activeProfileId !== prevProfileId) {
        prevProfileId = state.activeProfileId;
        if (termRef.current) {
          termRef.current.options.theme = state.xtermTheme();
        }
      }
    });

    // --- Channels for Rust → JS streaming -----------------------------------
    const onOutput = new Channel<PtyChunk>((msg) => {
      term.write(new Uint8Array(msg.data));
      if (paneId) {
        useTabsStore.getState().markPaneUnread(paneId);
      }
    });

    const onStatus = new Channel<SshStatus>((msg) => {
      console.log("[useXterm] onStatus raw:", JSON.stringify(msg));
      if (msg.kind === "connected") {
        setStatus("connected");
      } else if (msg.kind === "authenticating") {
        setStatus("authenticating");
      } else if (msg.kind === "disconnected") {
        setStatus("disconnected");
        setDisconnectReason(msg.reason);
      } else if (msg.kind === "passphraseNeeded") {
        setPassphrasePrompt({
          promptId: msg.promptId,
          keyPath: msg.keyPath,
        });
      } else if (msg.kind === "hostKeyPrompt") {
        setHostKeyPrompt({
          promptId: msg.promptId,
          host: msg.host,
          port: msg.port,
          algorithm: msg.algorithm,
          fingerprint: msg.fingerprint,
        });
      } else if (msg.kind === "credentialsNeeded") {
        setCredentialsPrompt({
          promptId: msg.promptId,
          username: msg.username,
          reason: msg.reason,
        });
      }
    });

    // --- Mouse gestures: right-click paste & copy-on-select ----------------
    // Load settings once, apply handlers. Settings are read on mount; if the
    // user changes them in Settings, terminals created after that pick them up.
    let rightClickPaste = true;
    let copyOnSelect = true;

    const loadMouseSettings = async () => {
      const [rcp, cos] = await Promise.all([
        settingsApi.get("terminal.rightClickPaste"),
        settingsApi.get("terminal.copyOnSelect"),
      ]);
      rightClickPaste = rcp !== "false"; // default true
      copyOnSelect = cos !== "false";     // default true
    };
    void loadMouseSettings();

    // Right-click → paste from clipboard
    const handleContextMenu = (e: MouseEvent) => {
      if (!rightClickPaste) return;
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        try {
          const text = await readText();
          if (text && runtimeIdRef.current) {
            const bytes = Array.from(new TextEncoder().encode(text));
            void ptyApi.writeToPty(runtimeIdRef.current, bytes);
          }
        } catch { /* clipboard empty or denied */ }
      })();
    };
    el.addEventListener("contextmenu", handleContextMenu);

    // Selection → copy to clipboard
    const selDisposable = term.onSelectionChange(() => {
      if (!copyOnSelect) return;
      const sel = term.getSelection();
      if (sel) {
        void writeText(sel);
      }
    });

    // Selection popup — show floating menu on mouseup when text is selected
    const handleSelMouseUp = (e: MouseEvent) => {
      // Small delay so xterm finalises the selection
      setTimeout(() => {
        const sel = term.getSelection();
        if (sel && sel.trim().length >= 2) {
          const rect = el.getBoundingClientRect();
          setSelectionPopup({
            text: sel,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        }
      }, 10);
    };
    const handleSelMouseDown = () => {
      setSelectionPopup(null);
    };
    el.addEventListener("mouseup", handleSelMouseUp);
    el.addEventListener("mousedown", handleSelMouseDown);

    let cancelled = false;
    let rid: string | null = null;

    // --- Open the session ---------------------------------------------------
    (async () => {
      try {
        rid = await ptyApi.openSession(
          sessionId,
          term.cols,
          term.rows,
          onOutput,
          onStatus,
        );
        if (cancelled) {
          // Component unmounted before connect completed
          void ptyApi.closeSession(rid);
          return;
        }
        runtimeIdRef.current = rid;

        // Register runtimeId in tabs store so StatusBar can poll remote stats
        if (paneId) {
          useTabsStore.getState().setPaneRuntimeId(paneId, rid);
        }

        // Best-effort remote OS detection — fire-and-forget. The Rust side
        // persists the result; we mirror it in the store so the tab icon
        // updates without a full sessions reload.
        void sshApi
          .detectOs(rid, sessionId)
          .then((os) => {
            if (os) useSessionsStore.getState().patchOsType(sessionId, os);
          })
          .catch(() => { /* detection is optional */ });

        // --- Keystroke forwarding -------------------------------------------
        term.onData((data) => {
          if (runtimeIdRef.current) {
            const bytes = Array.from(new TextEncoder().encode(data));
            void ptyApi.writeToPty(runtimeIdRef.current, bytes);
          }
        });

        // Binary data (e.g. from paste with non-UTF-8 bytes)
        term.onBinary((data) => {
          if (runtimeIdRef.current) {
            const bytes = Array.from(data, (c) => c.charCodeAt(0));
            void ptyApi.writeToPty(runtimeIdRef.current, bytes);
          }
        });
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(formatError(e));
        }
      }
    })();

    // --- Resize observer (debounced) ----------------------------------------
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        requestAnimationFrame(() => {
          if (fitRef.current && termRef.current && runtimeIdRef.current) {
            fitRef.current.fit();
            void ptyApi.resizePty(
              runtimeIdRef.current,
              termRef.current.cols,
              termRef.current.rows,
            );
          }
        });
      }, 50);
    });
    ro.observe(el);

    // --- Cleanup on unmount -------------------------------------------------
    return () => {
      cancelled = true;
      unsubTheme();
      selDisposable.dispose();
      el.removeEventListener("mouseup", handleSelMouseUp);
      el.removeEventListener("mousedown", handleSelMouseDown);
      el.removeEventListener("contextmenu", handleContextMenu);
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (paneId) {
        useTabsStore.getState().clearPaneRuntimeId(paneId);
      }
      if (runtimeIdRef.current) {
        void ptyApi.closeSession(runtimeIdRef.current);
        runtimeIdRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, reconnectKey]);

  return {
    status,
    error,
    disconnectReason,
    passphrasePrompt,
    clearPassphrasePrompt,
    hostKeyPrompt,
    clearHostKeyPrompt,
    credentialsPrompt,
    clearCredentialsPrompt,
    selectionPopup,
    clearSelectionPopup,
    close,
    reconnect,
  };
}
