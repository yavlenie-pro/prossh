import { Folder, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { detectOsFromSession, OsIcon, osColor } from "@/components/ui/OsIcon";
import { cn } from "@/lib/cn";
import { useSessionsStore } from "@/stores/sessions";
import type { Tab } from "@/stores/tabs";
import { useTabsStore } from "@/stores/tabs";

/**
 * Horizontal tab strip embedded inside the {@link TitleBar}. Tabs grow to
 * fill the available space up to a comfortable maximum width and each one
 * shows the host's OS icon next to the label. An unread-output dot appears
 * on inactive tabs that produced output since they were last focused.
 */
export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const closeTab = useTabsStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      data-tauri-drag-region
      className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto pl-1 pr-2 pt-1"
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          onActivate={() => activateTab(tab.id)}
          onClose={() => closeTab(tab.id)}
        />
      ))}
    </div>
  );
}

function TabButton({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const unread = useTabsStore((s) => !!s.unreadTabs[tab.id]);
  const session = useSessionsStore((s) =>
    s.sessions.find((x) => x.id === tab.sessionId),
  );
  const os = useMemo(() => detectOsFromSession(session), [session]);
  const isSftp = tab.root.type === "leaf" && tab.root.kind === "sftp";

  // Strip the `SFTP:` prefix from the display label because we now use an
  // explicit folder icon to indicate SFTP tabs.
  const displayLabel = isSftp ? tab.label.replace(/^SFTP:\s*/i, "") : tab.label;

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      onClick={onActivate}
      onMouseDown={(e) => {
        // Middle-click closes the tab (matches Chrome / VS Code / WT).
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "group relative flex min-w-[140px] max-w-[240px] flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded-t-md border-x border-t px-3 text-xs transition-colors",
        active
          ? "border-border-subtle bg-bg text-fg"
          : "border-transparent text-fg-muted hover:bg-bg-overlay hover:text-fg",
      )}
    >
      {/* Unread dot — slot is always reserved so neighbouring content
          doesn't jump when the dot appears on inactive tabs. */}
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          unread && !active ? "bg-accent" : "bg-transparent",
        )}
        aria-hidden={!unread || active}
      />

      {/* Icon column — SFTP gets a folder glyph overlaid on the OS color */}
      <span
        className="shrink-0"
        style={{ color: active ? osColor(os) : undefined }}
      >
        {isSftp ? <Folder size={14} /> : <OsIcon os={os} size={14} />}
      </span>

      <span className="min-w-0 flex-1 truncate" title={tab.label}>
        {displayLabel}
      </span>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          "shrink-0 rounded p-0.5 text-fg-subtle hover:bg-danger/20 hover:text-danger",
          active ? "block" : "hidden group-hover:block",
        )}
        aria-label={t("tabs.closeTab")}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
