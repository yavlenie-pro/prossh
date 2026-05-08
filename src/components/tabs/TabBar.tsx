import { Folder, X } from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
 * Tabs are reorderable by drag-and-drop, but we deliberately do NOT use the
 * native HTML5 dnd API here. Tauri 2 on Windows installs an OS-level
 * drag-and-drop handler on the webview (controlled by `dragDropEnabled`)
 * that hijacks the mouse mid-drag, which manifests as a "no-drop" cursor
 * and a never-firing `drop` event. Disabling that handler is the documented
 * workaround, but it would also break the Tauri `onDragDropEvent` listener
 * the sidebar's file browser relies on for "drop file from Explorer to
 * upload". Manual mouse tracking sidesteps the conflict entirely while
 * keeping the OS file-drop integration intact.
 *
 * The drag is initiated when the cursor leaves a small dead-zone (4 px) so
 * a normal click still activates the tab.
 */
export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const reorderTabs = useTabsStore((s) => s.reorderTabs);

  /**
   * `draggingId` — id of the tab currently being dragged (drives the dim
   * visual). `dropIndex` — insert-before position in the *current* tab
   * array; null both when idle and when the prospective drop is a no-op
   * (back to the same place).
   */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  /** Container ref so we can read tab rects relative to it. */
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Latest tabs snapshot, accessed from native event handlers attached to
   * `window`. Without this the global listeners would close over the array
   * from the render that armed them and miss new tabs / removals.
   */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  if (tabs.length === 0) return null;

  /**
   * Begin a manual drag gesture. We don't immediately mark the tab as
   * dragging — only after the cursor has moved past a small threshold, so
   * a clean click on a tab still activates it.
   */
  const beginDrag = (e: React.MouseEvent, tabId: string) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const THRESHOLD = 4;
    let started = false;

    const onMove = (ev: MouseEvent) => {
      if (!started) {
        if (
          Math.abs(ev.clientX - startX) < THRESHOLD &&
          Math.abs(ev.clientY - startY) < THRESHOLD
        ) {
          return;
        }
        started = true;
        setDraggingId(tabId);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      updateDropIndex(ev.clientX, tabId);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (started) {
        commitDrop(tabId);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
      setDraggingId(null);
      setDropIndex(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /**
   * Recompute the drop position from the cursor's X coordinate. We look at
   * each tab's bounding rect and find the gap closest to the cursor. The
   * indicator is suppressed for no-op moves (target is the source's own
   * slot or the slot immediately after).
   */
  const updateDropIndex = (clientX: number, dragId: string) => {
    const container = containerRef.current;
    if (!container) return;
    const tabEls = container.querySelectorAll<HTMLElement>('[data-tab-id]');
    if (tabEls.length === 0) return;

    const fromIndex = tabsRef.current.findIndex((t) => t.id === dragId);
    let candidate = tabEls.length; // default = drop at end
    for (let i = 0; i < tabEls.length; i++) {
      const r = tabEls[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) {
        candidate = i;
        break;
      }
    }

    if (candidate === fromIndex || candidate === fromIndex + 1) {
      setDropIndex(null);
    } else {
      setDropIndex(candidate);
    }
  };

  /**
   * Apply the queued drop. `dropIndex` uses insert-before semantics on the
   * pre-move array; convert it to the target index `reorderTabs` expects
   * (where the moved tab lands exactly at `toIndex` in the post-move
   * array).
   */
  const commitDrop = (dragId: string) => {
    setDropIndex((current) => {
      if (current === null) return null;
      const fromIndex = tabsRef.current.findIndex((t) => t.id === dragId);
      if (fromIndex === -1) return null;
      let toIndex = current;
      if (toIndex > fromIndex) toIndex--;
      if (toIndex !== fromIndex) reorderTabs(fromIndex, toIndex);
      return null;
    });
  };

  // Safety net: clear any leftover body styles if the component unmounts
  // while a drag is in progress.
  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  return (
    <div
      ref={containerRef}
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
            onMouseDownDrag={(e) => beginDrag(e, tab.id)}
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
  onMouseDownDrag,
}: {
  tab: Tab;
  active: boolean;
  dragging: boolean;
  onActivate: () => void;
  onClose: () => void;
  onMouseDownDrag: (e: React.MouseEvent) => void;
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
      data-tab-id={tab.id}
      onClick={onActivate}
      onMouseDown={(e) => {
        // Middle-click closes the tab (matches Chrome / VS Code / WT).
        if (e.button === 1) {
          e.preventDefault();
          onClose();
          return;
        }
        // Left-button: arm the manual drag tracker. It only activates after
        // the cursor moves past a small threshold, so a normal click still
        // selects the tab via `onClick`.
        if (e.button === 0) {
          onMouseDownDrag(e);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "group relative flex min-w-[140px] max-w-[240px] flex-1 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-t-md border-x border-t px-3 text-xs transition-colors",
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
        onMouseDown={(e) => {
          // Don't initiate a drag when the user is aiming at the close button.
          e.stopPropagation();
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
