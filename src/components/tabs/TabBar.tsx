import { Folder, X } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
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
 *
 * Tabs are reorderable by drag-and-drop: grabbing a tab and dropping it on
 * another inserts the dragged tab to that side of the target. A thin accent
 * line is rendered between tabs to indicate the upcoming insert position.
 */
export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const reorderTabs = useTabsStore((s) => s.reorderTabs);

  /**
   * `draggingId` — id of the tab currently being dragged. Tracked in BOTH a
   * ref (read synchronously from event handlers, so the very first
   * `dragover` after `dragstart` sees the new value before React commits the
   * next render) and React state (drives the dimmed-tab visual). Without the
   * ref the first `dragover` reads a stale closure where the id is still
   * null, the early return skips `preventDefault`, and the browser shows the
   * "no-drop" cursor for the rest of the drag.
   *
   * `dropIndex` — insert-before position in the *current* tab array; null
   * when the prospective drop is a no-op (back to the same place).
   */
  const draggingIdRef = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (tabs.length === 0) return null;

  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    draggingIdRef.current = tabId;
    setDraggingId(tabId);
    e.dataTransfer.effectAllowed = "move";
    // Some browsers require dataTransfer to be set for the drag to start.
    e.dataTransfer.setData("text/plain", tabId);
  };

  const handleDragEnd = () => {
    draggingIdRef.current = null;
    setDraggingId(null);
    setDropIndex(null);
  };

  const handleDragOver = (e: React.DragEvent, targetIndex: number) => {
    const dragId = draggingIdRef.current;
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientX - rect.left > rect.width / 2;
    const candidate = after ? targetIndex + 1 : targetIndex;
    const fromIndex = tabs.findIndex((t) => t.id === dragId);
    // Hide the indicator when the resulting move would be a no-op.
    if (candidate === fromIndex || candidate === fromIndex + 1) {
      setDropIndex(null);
    } else {
      setDropIndex(candidate);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dragId = draggingIdRef.current;
    const fromIndex = dragId ? tabs.findIndex((t) => t.id === dragId) : -1;
    if (fromIndex !== -1 && dropIndex !== null) {
      // dropIndex is "insert before" in the pre-move array. Convert it to the
      // post-move array index expected by reorderTabs (which lands the moved
      // tab exactly at toIndex).
      let toIndex = dropIndex;
      if (toIndex > fromIndex) toIndex--;
      if (toIndex !== fromIndex) reorderTabs(fromIndex, toIndex);
    }
    draggingIdRef.current = null;
    setDraggingId(null);
    setDropIndex(null);
  };

  return (
    <div
      role="tablist"
      data-tauri-drag-region
      className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto pl-1 pr-2 pt-1"
    >
      {tabs.map((tab, i) => (
        <Fragment key={tab.id}>
          {dropIndex === i && <DropIndicator />}
          <TabButton
            tab={tab}
            active={tab.id === activeTabId}
            dragging={draggingId === tab.id}
            onActivate={() => activateTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onDragStart={(e) => handleDragStart(e, tab.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={handleDrop}
          />
        </Fragment>
      ))}
      {dropIndex === tabs.length && <DropIndicator />}
    </div>
  );
}

/** Thin vertical bar shown between tabs at the prospective drop position. */
function DropIndicator() {
  return (
    <div
      aria-hidden
      className="my-1 w-0.5 shrink-0 self-stretch rounded-full bg-accent"
    />
  );
}

function TabButton({
  tab,
  active,
  dragging,
  onActivate,
  onClose,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  tab: Tab;
  active: boolean;
  dragging: boolean;
  onActivate: () => void;
  onClose: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
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
      draggable
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
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "group relative flex min-w-[140px] max-w-[240px] flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded-t-md border-x border-t px-3 text-xs transition-colors",
        active
          ? "border-border-subtle bg-bg text-fg"
          : "border-transparent text-fg-muted hover:bg-bg-overlay hover:text-fg",
        dragging && "opacity-50",
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
