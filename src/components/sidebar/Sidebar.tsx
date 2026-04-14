/**
 * Sidebar wrapper — sessions / file browser, resizable + collapsible.
 * Width and collapsed state persist in localStorage.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FolderOpen, Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { SessionsSidebar } from "@/components/sessions/SessionsSidebar";
import { FilesBrowser } from "@/components/sidebar/FilesBrowser";
import { TransferQueue } from "@/components/sidebar/TransferQueue";
import { useSidebarStore } from "@/stores/sidebar";

const LS_WIDTH = "prossh:sidebarWidth";
const LS_COLLAPSED = "prossh:sidebarCollapsed";
const DEFAULT_WIDTH = 256; // 16rem = w-64
const MIN_WIDTH = 160;
const MAX_WIDTH = 480;

function loadWidth(): number {
  try {
    const v = localStorage.getItem(LS_WIDTH);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    }
  } catch { /* noop */ }
  return DEFAULT_WIDTH;
}

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(LS_COLLAPSED) === "true";
  } catch { return false; }
}

export function Sidebar() {
  const { t } = useTranslation();
  const mode = useSidebarStore((s) => s.mode);
  const setMode = useSidebarStore((s) => s.setMode);
  const [width, setWidth] = useState(loadWidth);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  // Persist
  useEffect(() => {
    try { localStorage.setItem(LS_WIDTH, String(width)); } catch { /* noop */ }
  }, [width]);
  useEffect(() => {
    try { localStorage.setItem(LS_COLLAPSED, String(collapsed)); } catch { /* noop */ }
  }, [collapsed]);

  // Ctrl+B toggle (listened globally via AppShell, but also here for self-containment)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Drag resize ──────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [width]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW.current + delta));
      setWidth(next);
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Double-click on handle → reset to default
  const onDoubleClick = useCallback(() => {
    setWidth(DEFAULT_WIDTH);
  }, []);

  // ── Collapsed state ──────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside className="flex h-full w-10 shrink-0 flex-col border-r border-border-subtle bg-bg-elevated">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex items-center justify-center py-3 text-fg-muted hover:text-fg"
          title={t("sidebar.expand")}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => { setCollapsed(false); setMode("sessions"); }}
          className={cn(
            "flex items-center justify-center py-2",
            mode === "sessions" ? "text-accent" : "text-fg-muted hover:text-fg",
          )}
          title={t("files.sessions")}
        >
          <Server className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => { setCollapsed(false); setMode("files"); }}
          className={cn(
            "flex items-center justify-center py-2",
            mode === "files" ? "text-accent" : "text-fg-muted hover:text-fg",
          )}
          title={t("files.fileBrowser")}
        >
          <FolderOpen className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  // ── Expanded state ───────────────────────────────────────────────────────
  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-border-subtle bg-bg-elevated"
      style={{ width }}
    >
      {/* Mode switcher — icon-only tabs */}
      <div className="flex border-b border-border-subtle">
        <button
          type="button"
          onClick={() => setMode("sessions")}
          className={cn(
            "flex flex-1 items-center justify-center py-2 transition-colors",
            mode === "sessions"
              ? "border-b-2 border-accent text-accent"
              : "text-fg-muted hover:bg-bg-overlay hover:text-fg",
          )}
          title={t("files.sessions")}
        >
          <Server className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setMode("files")}
          className={cn(
            "flex flex-1 items-center justify-center py-2 transition-colors",
            mode === "files"
              ? "border-b-2 border-accent text-accent"
              : "text-fg-muted hover:bg-bg-overlay hover:text-fg",
          )}
          title={t("files.fileBrowser")}
        >
          <FolderOpen className="h-4 w-4" />
        </button>
        {/* Collapse button */}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="flex items-center justify-center px-1.5 text-fg-muted hover:text-fg"
          title={t("sidebar.collapse")}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1">
        {mode === "sessions" ? <SessionsSidebar /> : <FilesBrowser />}
      </div>

      {/* Transfer queue — always visible at bottom */}
      <TransferQueue />

      {/* Drag handle */}
      <div
        className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60"
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
      />
    </aside>
  );
}
