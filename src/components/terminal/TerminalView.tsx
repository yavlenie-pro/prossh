import { useEffect, useRef } from "react";
import { AlertTriangle, ClipboardCopy, Loader2, Plus, RefreshCw, Unplug } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import type { Session } from "@/api/types";
import { scriptsApi } from "@/api/scripts";
import { CredentialsDialog } from "@/components/dialogs/CredentialsDialog";
import { HostKeyPromptDialog } from "@/components/dialogs/HostKeyPromptDialog";
import { PassphraseDialog } from "@/components/dialogs/PassphraseDialog";
import { useXterm } from "@/hooks/useXterm";
import { useThemeStore } from "@/stores/theme";

/** Pattern → i18n key + capture-group mapping for known backend errors. */
const ERROR_PATTERNS: [RegExp, string, string[]][] = [
  [/^TCP connect to (.+) timed out after (\d+)s$/, "terminal.errors.tcpTimeout", ["addr", "sec"]],
  [/^TCP\/SSH handshake with (.+) timed out after (\d+)s$/, "terminal.errors.handshakeTimeout", ["addr", "sec"]],
  [/^could not resolve (.+)$/, "terminal.errors.dnsResolve", ["addr"]],
  [/^DNS lookup for (.+?): (.+)$/, "terminal.errors.dnsLookup", ["host", "detail"]],
  [/^TCP connect to (.+?): (.+)$/, "terminal.errors.tcpConnect", ["addr", "detail"]],
  [/^SSH handshake: (.+)$/, "terminal.errors.sshHandshake", ["detail"]],
  [/^password auth timed out after (\d+)s$/, "terminal.errors.passwordTimeout", ["sec"]],
  [/^public key auth timed out after (\d+)s$/, "terminal.errors.keyTimeout", ["sec"]],
  [/^authentication failed$/, "terminal.errors.authFailed", []],
  [/^no password stored$/, "terminal.errors.noPassword", []],
  [/^no private key path configured/, "terminal.errors.noKey", []],
  [/^credentials prompt cancelled/, "terminal.errors.credentialsCancelled", []],
  [/^public key authentication rejected/, "terminal.errors.keyRejected", []],
];

function translateError(msg: string, t: TFunction): string {
  for (const [re, key, names] of ERROR_PATTERNS) {
    const m = re.exec(msg);
    if (m) {
      const params: Record<string, string> = {};
      names.forEach((n, i) => { params[n] = m[i + 1]; });
      return t(key, params);
    }
  }
  return msg;
}

interface Props {
  session: Session;
  paneId: string;
}

/**
 * Renders a live xterm.js terminal connected to a remote SSH shell.
 *
 * For step 6 this is a single full-size pane; step 7 wraps it in the
 * split-pane / tabs machinery.
 */
export function TerminalView({ session, paneId }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const themeBg = useThemeStore((s) => s.xtermTheme().background ?? "#1a1b26");
  const {
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
    reconnect,
  } = useXterm(containerRef, session.id, paneId);

  const handleCopy = () => {
    if (selectionPopup) {
      void writeText(selectionPopup.text);
      clearSelectionPopup();
    }
  };

  const handleAddToScripts = () => {
    if (!selectionPopup) return;
    const command = selectionPopup.text.trim();
    clearSelectionPopup();
    void scriptsApi.upsert({
      sessionId: session.id,
      name: command.length > 40 ? command.slice(0, 40) + "…" : command,
      command,
    });
  };

  // Hotkey: R to reconnect when disconnected or error
  useEffect(() => {
    if (status !== "disconnected" && status !== "error") return;
    const handler = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea (e.g. dialog)
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        reconnect();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [status, reconnect]);

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* Status overlay — shown on top of the terminal */}
      {(status === "connecting" || status === "authenticating") && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80">
          <div className="flex flex-col items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>
              {status === "authenticating"
                ? t("terminal.authenticating")
                : t("terminal.connecting")}{" "}
              {session.host}:{session.port}
            </span>
          </div>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/90">
          <div className="max-w-md rounded-lg border border-danger/30 bg-bg-elevated px-6 py-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-danger">
              <AlertTriangle className="h-4 w-4" />
              {t("terminal.error")}
            </div>
            <pre className="whitespace-pre-wrap font-mono text-xs text-fg-muted">
              {error ? translateError(error, t) : ""}
            </pre>
            <button
              type="button"
              onClick={reconnect}
              className="mt-3 flex items-center gap-1.5 rounded px-3 py-1 text-xs text-accent hover:bg-accent/15"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("terminal.reconnect")}
              <kbd className="ml-1 rounded border border-border-subtle bg-bg-overlay px-1 py-0.5 font-mono text-[10px] text-fg-subtle">R</kbd>
            </button>
          </div>
        </div>
      )}
      {status === "disconnected" && (
        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-border-subtle bg-bg-elevated/90 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Unplug className="h-3.5 w-3.5" />
            <span>
              {t("terminal.disconnected")}
              {disconnectReason && (
                <span className="ml-1 text-fg-subtle">({disconnectReason})</span>
              )}
            </span>
            <button
              type="button"
              onClick={reconnect}
              className="ml-2 flex items-center gap-1 rounded px-2 py-0.5 text-xs text-accent hover:bg-accent/15"
            >
              <RefreshCw className="h-3 w-3" />
              {t("terminal.reconnect")}
              <kbd className="ml-1 rounded border border-border-subtle bg-bg-overlay px-1 py-0.5 font-mono text-[10px] text-fg-subtle">R</kbd>
            </button>
          </div>
        </div>
      )}

      {/* The xterm.js container — always rendered so the terminal can measure
          its size even while connecting (FitAddon needs a DOM element). */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1"
        style={{ backgroundColor: themeBg }}
      />

      {/* Selection popup — floating context menu on text selection */}
      {selectionPopup && (
        <div
          className="absolute z-20 flex overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated shadow-xl"
          style={{ left: selectionPopup.x, top: selectionPopup.y + 4 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg hover:bg-accent/15"
          >
            <ClipboardCopy className="h-3.5 w-3.5 text-fg-subtle" />
            {t("terminal.copy")}
          </button>
          <div className="w-px bg-border-subtle" />
          <button
            type="button"
            onClick={handleAddToScripts}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg hover:bg-accent/15"
          >
            <Plus className="h-3.5 w-3.5 text-fg-subtle" />
            {t("terminal.addToScripts")}
          </button>
        </div>
      )}

      {/* Passphrase prompt overlay */}
      {passphrasePrompt && (
        <PassphraseDialog
          promptId={passphrasePrompt.promptId}
          keyPath={passphrasePrompt.keyPath}
          onDone={clearPassphrasePrompt}
        />
      )}

      {/* Credentials prompt overlay */}
      {credentialsPrompt && (
        <CredentialsDialog
          promptId={credentialsPrompt.promptId}
          username={credentialsPrompt.username}
          reason={credentialsPrompt.reason}
          onDone={clearCredentialsPrompt}
        />
      )}

      {/* Host key prompt overlay */}
      {hostKeyPrompt && (
        <HostKeyPromptDialog
          promptId={hostKeyPrompt.promptId}
          host={hostKeyPrompt.host}
          port={hostKeyPrompt.port}
          algorithm={hostKeyPrompt.algorithm}
          fingerprint={hostKeyPrompt.fingerprint}
          onDone={clearHostKeyPrompt}
        />
      )}
    </div>
  );
}
