import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { settingsApi } from "@/api/settings";
import { sessionsApi } from "@/api/sessions";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { SplitPane } from "@/components/panes/SplitPane";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { AppLogo } from "@/components/ui/AppLogo";
import { useTabsStore } from "@/stores/tabs";

import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";

/**
 * Top-level frame: custom titlebar + tab bar + sidebar + main body + status
 * bar. When no tabs are open, shows a welcome screen. Clicking a session in
 * the sidebar opens it directly as a terminal tab.
 */
export function AppShell() {
  const { t } = useTranslation();

  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const closeTab = useTabsStore((s) => s.closeTab);
  const splitPane = useTabsStore((s) => s.splitPane);
  const openTab = useTabsStore((s) => s.openTab);
  const openSftpTab = useTabsStore((s) => s.openSftpTab);
  const activateTab = useTabsStore((s) => s.activateTab);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsFromPalette, setSettingsFromPalette] = useState(false);
  const restoredRef = useRef(false);

  // --- Restore saved sessions on startup ---
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      const enabled = await settingsApi.get("app.restoreSessions");
      if (enabled !== "true") return;
      const saved = await settingsApi.get("app.openTabs");
      if (!saved) return;
      try {
        const items: { sessionId: string; label: string; isSftp: boolean; isActive: boolean }[] = JSON.parse(saved);
        // Verify sessions still exist
        const sessions = await sessionsApi.list();
        const ids = new Set(sessions.map((s) => s.id));
        let activeId: string | null = null;
        for (const item of items) {
          if (!ids.has(item.sessionId)) continue;
          if (item.isSftp) {
            openSftpTab(item.sessionId, item.label);
          } else {
            openTab(item.sessionId, item.label);
          }
          if (item.isActive) {
            const last = useTabsStore.getState().tabs.at(-1);
            if (last) activeId = last.id;
          }
        }
        if (activeId) activateTab(activeId);
      } catch { /* corrupted JSON — skip */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Persist open tabs on every change (debounced) ----------------------
  // beforeunload + async invoke is unreliable — the IPC call can be dropped
  // before the process exits. Instead, subscribe to the store and debounce-
  // save whenever tabs change. On startup we check the setting once.
  const restoreEnabledRef = useRef<boolean | null>(null);

  // Cache the setting so we don't read it on every save
  useEffect(() => {
    void settingsApi.get("app.restoreSessions").then((v) => {
      restoreEnabledRef.current = v === "true";
    });
  }, []);

  const saveTabs = useCallback(() => {
    if (restoreEnabledRef.current !== true) return;
    const { tabs: currentTabs, activeTabId: currentActive } = useTabsStore.getState();
    const items = currentTabs.map((tab) => ({
      sessionId: tab.sessionId,
      label: tab.label,
      isSftp: tab.root.type === "leaf" && tab.root.kind === "sftp",
      isActive: tab.id === currentActive,
    }));
    void settingsApi.set("app.openTabs", JSON.stringify(items));
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useTabsStore.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(saveTabs, 500);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [saveTabs]);

  // --- Auto-focus terminal of active tab ------------------------------------
  // Tabs stay mounted and are toggled via CSS, so xterm.focus() from useXterm
  // only runs once per mount. Re-focus the active tab's terminal whenever
  // activeTabId changes (click, palette, auto-switch on close, restore).
  useEffect(() => {
    if (!activeTabId) return;
    const raf = requestAnimationFrame(() => {
      const active = document.querySelector('[data-active-tab="true"]');
      active?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTabId]);

  // --- Keyboard shortcuts ---------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Use e.code (physical key) so shortcuts work regardless of keyboard layout
      // Ctrl+Shift+P → command palette
      if (e.ctrlKey && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // Escape → close palette and refocus terminal
      if (e.code === "Escape" && paletteOpen) {
        e.preventDefault();
        setPaletteOpen(false);
        requestAnimationFrame(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>(
            ".xterm-helper-textarea",
          );
          textarea?.focus();
        });
        return;
      }
      // Ctrl+W → close active tab
      if (e.ctrlKey && !e.shiftKey && e.code === "KeyW") {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
        return;
      }
      // Ctrl+Shift+D → split horizontal
      if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        splitPane("horizontal");
        return;
      }
      // Ctrl+Shift+E → split vertical
      if (e.ctrlKey && e.shiftKey && e.code === "KeyE") {
        e.preventDefault();
        splitPane("vertical");
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabId, closeTab, splitPane, paletteOpen]);

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Render ALL tabs to keep terminals alive; hide inactive with CSS */}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              data-active-tab={tab.id === activeTabId ? "true" : undefined}
              className={
                tab.id === activeTabId
                  ? "flex min-h-0 flex-1 flex-col"
                  : "invisible absolute inset-0 -z-10"
              }
            >
              <SplitPane node={tab.root} />
            </div>
          ))}
          {tabs.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-fg-muted">
              <div className="flex flex-col items-center text-center">
                <AppLogo size={56} className="mb-4 text-accent/80" />
                <div className="mb-2 font-mono text-xl">{t("app.name")}</div>
                <div className="text-sm">
                  {t("app.selectSession")}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
      <StatusBar />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenSettings={() => setSettingsFromPalette(true)}
      />

      <SettingsDialog
        open={settingsFromPalette}
        onOpenChange={setSettingsFromPalette}
        initialTab="appearance"
      />
    </div>
  );
}
