import { useEffect, useState } from "react";
import { Command } from "cmdk";
import {
  Code2,
  FolderOpen,
  Palette,
  Settings2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  TerminalSquare,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { ptyApi } from "@/api/pty";
import { useScriptsStore } from "@/stores/scripts";
import { useSessionsStore } from "@/stores/sessions";
import { useTabsStore } from "@/stores/tabs";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
}

/**
 * Global command palette (Ctrl+Shift+P).
 * Uses cmdk for fuzzy-search filtering.
 */
export function CommandPalette({ open, onOpenChange, onOpenSettings }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const sessions = useSessionsStore((s) => s.sessions);
  const openTab = useTabsStore((s) => s.openTab);
  const openSftpTab = useTabsStore((s) => s.openSftpTab);
  const splitPane = useTabsStore((s) => s.splitPane);

  // Scripts
  const scripts = useScriptsStore((s) => s.scripts);
  const loadScripts = useScriptsStore((s) => s.load);

  // Active terminal info for running scripts
  const focusedPaneId = useTabsStore((s) => s.focusedPaneId);
  const paneRuntimeIds = useTabsStore((s) => s.paneRuntimeIds);
  const activeRuntimeId = focusedPaneId ? paneRuntimeIds[focusedPaneId] ?? null : null;

  // Figure out which session the active terminal belongs to
  const activeTab = useTabsStore((s) => {
    const tid = s.activeTabId;
    return tid ? s.tabs.find((tab) => tab.id === tid) : undefined;
  });
  const activeSessionId = activeTab?.sessionId ?? null;

  useEffect(() => {
    if (open) {
      setSearch("");
      // Load scripts for the active session (global + session-specific)
      void loadScripts(activeSessionId ?? undefined);
    }
  }, [open, activeSessionId, loadScripts]);

  /** Refocus the active xterm terminal after the palette closes. */
  const refocusTerminal = () => {
    requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      textarea?.focus();
    });
  };

  const run = (fn: () => void) => {
    fn();
    onOpenChange(false);
    refocusTerminal();
  };

  /** Send a script command to the active PTY + press Enter */
  const executeScript = (command: string) => {
    if (!activeRuntimeId) return;
    const text = command + "\n";
    const bytes = Array.from(new TextEncoder().encode(text));
    void ptyApi.writeToPty(activeRuntimeId, bytes);
  };

  if (!open) return null;

  const globalScripts = scripts.filter((s) => s.sessionId === null);
  const sessionScripts = scripts.filter((s) => s.sessionId !== null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={() => { onOpenChange(false); refocusTerminal(); }}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border-subtle bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" shouldFilter>
          <div className="flex items-center border-b border-border-subtle px-3">
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={t("palette.placeholder")}
              className="flex-1 bg-transparent py-3 text-sm text-fg outline-none placeholder:text-fg-subtle"
              autoFocus
            />
            <button
              type="button"
              onClick={() => { onOpenChange(false); refocusTerminal(); }}
              className="ml-2 text-fg-subtle hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <Command.List className="max-h-72 overflow-y-auto p-1">
            <Command.Empty className="py-6 text-center text-xs text-fg-muted">
              {t("palette.noResults")}
            </Command.Empty>

            {/* Scripts — Global */}
            {globalScripts.length > 0 && (
              <Command.Group heading={t("palette.globalScripts")}>
                {globalScripts.map((sc) => (
                  <Command.Item
                    key={`script-${sc.id}`}
                    value={`script ${sc.name} ${sc.command}`}
                    onSelect={() => run(() => executeScript(sc.command))}
                    disabled={!activeRuntimeId}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg aria-selected:bg-accent/15 aria-disabled:opacity-40"
                  >
                    <Code2 className="h-3.5 w-3.5 text-fg-subtle" />
                    {sc.name}
                    <span className="ml-auto max-w-[200px] truncate font-mono text-[10px] text-fg-muted">
                      {sc.command}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Scripts — Session-specific */}
            {sessionScripts.length > 0 && (
              <Command.Group heading={t("palette.sessionScripts")}>
                {sessionScripts.map((sc) => (
                  <Command.Item
                    key={`script-${sc.id}`}
                    value={`script session ${sc.name} ${sc.command}`}
                    onSelect={() => run(() => executeScript(sc.command))}
                    disabled={!activeRuntimeId}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg aria-selected:bg-accent/15 aria-disabled:opacity-40"
                  >
                    <Code2 className="h-3.5 w-3.5 text-accent" />
                    {sc.name}
                    <span className="ml-auto max-w-[200px] truncate font-mono text-[10px] text-fg-muted">
                      {sc.command}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Sessions — single list with SSH / SFTP action buttons */}
            <Command.Group heading={t("sidebar.sessions")}>
              {sessions.map((s) => (
                <Command.Item
                  key={`session-${s.id}`}
                  value={`${s.id} connect sftp ${s.name} ${s.host} ${s.username}`}
                  onSelect={() => run(() => openTab(s.id, s.name))}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg aria-selected:bg-accent/15"
                >
                  <TerminalSquare className="h-3.5 w-3.5 text-fg-subtle" />
                  <span className="min-w-0 truncate">{s.name}</span>
                  <span className="ml-auto flex items-center gap-2 text-fg-muted">
                    <span className="truncate text-[10px]">{s.username}@{s.host}</span>
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px] text-fg-subtle hover:bg-accent/20 hover:text-accent"
                      onClick={(e) => { e.stopPropagation(); run(() => openSftpTab(s.id, s.name)); }}
                      title="SFTP"
                    >
                      <FolderOpen className="h-3 w-3" />
                    </button>
                  </span>
                </Command.Item>
              ))}
            </Command.Group>

            {/* Actions */}
            <Command.Group heading={t("palette.actions")}>
              <Command.Item
                value="split horizontal"
                onSelect={() => run(() => splitPane("horizontal"))}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg aria-selected:bg-accent/15"
              >
                <SplitSquareHorizontal className="h-3.5 w-3.5 text-fg-subtle" />
                {t("palette.splitH")}
              </Command.Item>
              <Command.Item
                value="split vertical"
                onSelect={() => run(() => splitPane("vertical"))}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg aria-selected:bg-accent/15"
              >
                <SplitSquareVertical className="h-3.5 w-3.5 text-fg-subtle" />
                {t("palette.splitV")}
              </Command.Item>
              <Command.Item
                value="open settings preferences"
                onSelect={() => run(onOpenSettings)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg aria-selected:bg-accent/15"
              >
                <Settings2 className="h-3.5 w-3.5 text-fg-subtle" />
                {t("palette.openSettings")}
              </Command.Item>
              <Command.Item
                value="change color profile theme"
                onSelect={() => run(onOpenSettings)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg aria-selected:bg-accent/15"
              >
                <Palette className="h-3.5 w-3.5 text-fg-subtle" />
                {t("palette.changeTheme")}
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
