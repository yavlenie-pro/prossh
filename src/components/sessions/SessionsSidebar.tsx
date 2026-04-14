import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileDown,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Server,
  TextCursorInput,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { settingsApi } from "@/api/settings";
import type { Group, Session } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { ConnectionDialog } from "@/components/dialogs/ConnectionDialog";
import { ImportSshConfigDialog } from "@/components/dialogs/ImportSshConfigDialog";
import { ImportPuttyDialog } from "@/components/dialogs/ImportPuttyDialog";
import { ImportMobaDialog } from "@/components/dialogs/ImportMobaDialog";
import { cn } from "@/lib/cn";
import { useSessionsStore } from "@/stores/sessions";
import { useSidebarStore } from "@/stores/sidebar";
import { useTabsStore } from "@/stores/tabs";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build maps for tree traversal. */
function buildGroupTree(groups: Group[]) {
  const childrenOf = new Map<string | null, Group[]>();
  for (const g of groups) {
    const key = g.parentId ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(g);
  }
  return childrenOf;
}

/** Count all sessions in a group and its descendants recursively. */
function countDeep(
  groupId: string,
  childrenOf: Map<string | null, Group[]>,
  sessionsByGroup: Map<string | null, Session[]>,
): number {
  let count = (sessionsByGroup.get(groupId) ?? []).length;
  for (const child of childrenOf.get(groupId) ?? []) {
    count += countDeep(child.id, childrenOf, sessionsByGroup);
  }
  return count;
}

// ── Component ────────────────────────────────────────────────────────────

export function SessionsSidebar() {
  const { t } = useTranslation();
  const sessions = useSessionsStore((s) => s.sessions);
  const groups = useSessionsStore((s) => s.groups);
  const loading = useSessionsStore((s) => s.loading);
  const error = useSessionsStore((s) => s.error);
  const load = useSessionsStore((s) => s.load);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const duplicateSession = useSessionsStore((s) => s.duplicateSession);
  const upsertSession = useSessionsStore((s) => s.upsertSession);
  const upsertGroup = useSessionsStore((s) => s.upsertGroup);
  const deleteGroup = useSessionsStore((s) => s.deleteGroup);
  const rawOpenTab = useTabsStore((s) => s.openTab);
  const openSftpTab = useTabsStore((s) => s.openSftpTab);
  const setSidebarMode = useSidebarStore((s) => s.setMode);

  // Wrap openTab to also switch sidebar to SFTP when setting is enabled
  const autoSftpRef = useRef<boolean | null>(null);
  useEffect(() => {
    void settingsApi.get("app.autoSftpTab").then((v) => {
      autoSftpRef.current = v === "true";
    });
  }, []);

  const openTab = useCallback(
    (sessionId: string, label: string) => {
      rawOpenTab(sessionId, label);
      if (autoSftpRef.current) {
        setSidebarMode("files");
      }
    },
    [rawOpenTab, setSidebarMode],
  );

  const openSftp = useCallback(
    (sessionId: string, label: string) => {
      openSftpTab(sessionId, label);
    },
    [openSftpTab],
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importSshOpen, setImportSshOpen] = useState(false);
  const [importPuttyOpen, setImportPuttyOpen] = useState(false);
  const [importMobaOpen, setImportMobaOpen] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Expanded groups (default = all collapsed).
  // Persisted in localStorage so the state survives reloads.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("prossh:expandedGroups");
      return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setDialogOpen(true);
  };

  const openEdit = (id: string) => {
    setEditingId(id);
    setDialogOpen(true);
  };

  const editing = editingId
    ? sessions.find((s) => s.id === editingId) ?? null
    : null;

  const toggleGroup = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { localStorage.setItem("prossh:expandedGroups", JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
  };

  const handleNewGroup = (parentId: string | null = null) => {
    const name = prompt(t("sidebar.newGroup"));
    if (name?.trim()) {
      void upsertGroup({ name: name.trim(), parentId });
    }
  };

  const handleRenameGroup = (group: Group) => {
    const name = prompt(t("sidebar.renameGroup"), group.name);
    if (name?.trim() && name.trim() !== group.name) {
      void upsertGroup({ id: group.id, name: name.trim(), parentId: group.parentId });
    }
  };

  const handleDeleteGroup = (group: Group) => {
    if (confirm(t("sidebar.deleteGroup", { name: group.name }))) {
      void deleteGroup(group.id);
    }
  };

  const handleRenameSession = (session: Session, newName: string) => {
    if (newName.trim() && newName.trim() !== session.name) {
      void upsertSession({
        id: session.id,
        name: newName.trim(),
        host: session.host,
        port: session.port,
        username: session.username,
        authMethod: session.authMethod,
        privateKeyPath: session.privateKeyPath,
        useKeychain: session.useKeychain,
        groupId: session.groupId,
        description: session.description,
        color: session.color,
      });
    }
    setRenamingSessionId(null);
  };

  // Build lookup maps
  const sessionsByGroup = new Map<string | null, Session[]>();
  for (const s of sessions) {
    const key = s.groupId ?? null;
    if (!sessionsByGroup.has(key)) sessionsByGroup.set(key, []);
    sessionsByGroup.get(key)!.push(s);
  }

  const childrenOf = buildGroupTree(groups);
  const rootGroups = childrenOf.get(null) ?? [];
  const ungrouped = sessionsByGroup.get(null) ?? [];

  // Search: case-insensitive match against name, host, username
  const query = search.trim().toLowerCase();
  const isSearching = query.length > 0;
  const filteredSessions = isSearching
    ? sessions.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.host.toLowerCase().includes(query) ||
          s.username.toLowerCase().includes(query),
      )
    : [];

  return (
    <>
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
          <div className="flex items-center gap-1">
            {/* Import dropdown */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Import"
                  aria-label="Import"
                >
                  <FileDown className="h-4 w-4" />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="z-50 min-w-[180px] rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-xl"
                  sideOffset={4}
                >
                  <DropdownMenu.Item
                    className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
                    onSelect={() => setImportSshOpen(true)}
                  >
                    {t("sidebar.importSshConfig")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
                    onSelect={() => setImportPuttyOpen(true)}
                  >
                    {t("sidebar.importPutty")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
                    onSelect={() => setImportMobaOpen(true)}
                  >
                    {t("sidebar.importMobaXterm")}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>

            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => handleNewGroup(null)}
              title={t("sidebar.newGroup")}
              aria-label={t("sidebar.newGroup")}
            >
              <FolderPlus className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={openCreate}
              title={t("sidebar.newSession")}
              aria-label={t("sidebar.newSession")}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* Search input */}
        <div className="relative border-b border-border-subtle px-2 py-1.5">
          <Search className="absolute left-3.5 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-subtle" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("sidebar.searchPlaceholder")}
            className="w-full rounded border border-border-subtle bg-bg py-1 pl-6 pr-6 text-xs text-fg placeholder:text-fg-subtle outline-none focus:border-accent"
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(""); searchRef.current?.focus(); }}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-subtle hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {loading && sessions.length === 0 && (
            <div className="px-3 py-4 text-xs text-fg-muted">Loading…</div>
          )}

          {error && (
            <div className="mx-3 my-2 rounded border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger">
              {error}
            </div>
          )}

          {!loading && sessions.length === 0 && !error && (
            <div className="px-3 py-10 text-center text-xs text-fg-muted">
              <div>{t("sidebar.noSessions")}</div>
              <button
                type="button"
                onClick={openCreate}
                className="mt-2 text-accent hover:text-accent-hover"
              >
                {t("sidebar.createFirst")}
              </button>
            </div>
          )}

          {isSearching ? (
            /* Flat search results */
            <>
              {filteredSessions.length === 0 && sessions.length > 0 && (
                <div className="px-3 py-6 text-center text-xs text-fg-muted">
                  {t("palette.noResults")}
                </div>
              )}
              {filteredSessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  depth={0}
                  renaming={renamingSessionId === s.id}
                  onConnect={() => openTab(s.id, s.name)}
                  onOpenSftp={() => openSftp(s.id, s.name)}
                  onEdit={() => openEdit(s.id)}
                  onDelete={() => {
                    if (confirm(t("sidebar.deleteConfirm", { name: s.name }))) {
                      void deleteSession(s.id);
                    }
                  }}
                  onDuplicate={() => void duplicateSession(s)}
                  onStartRename={() => setRenamingSessionId(s.id)}
                  onCommitRename={(name) => handleRenameSession(s, name)}
                  t={t}
                />
              ))}
            </>
          ) : (
            /* Normal group tree */
            <>
              {/* Recursive group tree */}
              {rootGroups.map((group) => (
                <GroupNode
                  key={group.id}
                  group={group}
                  depth={0}
                  expanded={expanded}
                  childrenOf={childrenOf}
                  sessionsByGroup={sessionsByGroup}
                  renamingSessionId={renamingSessionId}
                  onToggle={toggleGroup}
                  onConnect={(s) => openTab(s.id, s.name)}
                  onOpenSftp={(s) => openSftp(s.id, s.name)}
                  onEdit={openEdit}
                  onDeleteSession={(s) => {
                    if (confirm(t("sidebar.deleteConfirm", { name: s.name }))) {
                      void deleteSession(s.id);
                    }
                  }}
                  onDuplicateSession={(s) => void duplicateSession(s)}
                  onStartRename={(id) => setRenamingSessionId(id)}
                  onCommitRename={handleRenameSession}
                  onNewSubgroup={handleNewGroup}
                  onRenameGroup={handleRenameGroup}
                  onDeleteGroup={handleDeleteGroup}
                  t={t}
                />
              ))}

              {/* Ungrouped sessions */}
              {ungrouped.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  depth={0}
                  renaming={renamingSessionId === s.id}
                  onConnect={() => openTab(s.id, s.name)}
                  onOpenSftp={() => openSftp(s.id, s.name)}
                  onEdit={() => openEdit(s.id)}
                  onDelete={() => {
                    if (confirm(t("sidebar.deleteConfirm", { name: s.name }))) {
                      void deleteSession(s.id);
                    }
                  }}
                  onDuplicate={() => void duplicateSession(s)}
                  onStartRename={() => setRenamingSessionId(s.id)}
                  onCommitRename={(name) => handleRenameSession(s, name)}
                  t={t}
                />
              ))}
            </>
          )}
        </div>
      </div>

      <ConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        session={editing}
      />

      <ImportSshConfigDialog
        open={importSshOpen}
        onOpenChange={(v) => {
          setImportSshOpen(v);
          if (!v) void load();
        }}
      />

      <ImportPuttyDialog
        open={importPuttyOpen}
        onOpenChange={(v) => {
          setImportPuttyOpen(v);
          if (!v) void load();
        }}
      />

      <ImportMobaDialog
        open={importMobaOpen}
        onOpenChange={(v) => {
          setImportMobaOpen(v);
          if (!v) void load();
        }}
      />
    </>
  );
}

// ── Recursive group node ─────────────────────────────────────────────────

interface GroupNodeProps {
  group: Group;
  depth: number;
  expanded: Set<string>;
  childrenOf: Map<string | null, Group[]>;
  sessionsByGroup: Map<string | null, Session[]>;
  renamingSessionId: string | null;
  onToggle: (id: string) => void;
  onConnect: (s: Session) => void;
  onOpenSftp: (s: Session) => void;
  onEdit: (id: string) => void;
  onDeleteSession: (s: Session) => void;
  onDuplicateSession: (s: Session) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (s: Session, name: string) => void;
  onNewSubgroup: (parentId: string) => void;
  onRenameGroup: (g: Group) => void;
  onDeleteGroup: (g: Group) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function GroupNode({
  group,
  depth,
  expanded,
  childrenOf,
  sessionsByGroup,
  renamingSessionId,
  onToggle,
  onConnect,
  onOpenSftp,
  onEdit,
  onDeleteSession,
  onDuplicateSession,
  onStartRename,
  onCommitRename,
  onNewSubgroup,
  onRenameGroup,
  onDeleteGroup,
  t,
}: GroupNodeProps) {
  const isCollapsed = !expanded.has(group.id);
  const groupSessions = sessionsByGroup.get(group.id) ?? [];
  const childGroups = childrenOf.get(group.id) ?? [];
  const totalCount = countDeep(group.id, childrenOf, sessionsByGroup);
  const paddingLeft = 8 + depth * 16; // px

  return (
    <div>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className="group flex cursor-pointer items-center gap-1 py-1 pr-2 text-xs text-fg-muted hover:bg-bg-overlay"
            style={{ paddingLeft }}
            onClick={() => onToggle(group.id)}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0" />
            )}
            <span className="flex-1 truncate font-medium">
              {group.name}
            </span>
            <span className="text-[10px] text-fg-subtle">
              {totalCount}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRenameGroup(group);
              }}
              className="rounded p-0.5 text-fg-subtle opacity-0 hover:text-fg group-hover:opacity-100"
              title={t("sidebar.renameGroup")}
            >
              ✎
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteGroup(group);
              }}
              className="rounded p-0.5 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
              title="Delete"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="z-50 min-w-[160px] rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-xl">
            <ContextMenu.Item
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
              onSelect={() => onNewSubgroup(group.id)}
            >
              <FolderPlus className="mr-1.5 inline h-3 w-3" />
              {t("sidebar.newGroup")}
            </ContextMenu.Item>
            <ContextMenu.Item
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
              onSelect={() => onRenameGroup(group)}
            >
              {t("sidebar.renameGroup")}
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
            <ContextMenu.Item
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-danger outline-none hover:bg-danger/10"
              onSelect={() => onDeleteGroup(group)}
            >
              <Trash2 className="mr-1.5 inline h-3 w-3" />
              {t("sidebar.deleteGroup", { name: group.name })}
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {!isCollapsed && (
        <>
          {/* Child groups */}
          {childGroups.map((child) => (
            <GroupNode
              key={child.id}
              group={child}
              depth={depth + 1}
              expanded={expanded}
              childrenOf={childrenOf}
              sessionsByGroup={sessionsByGroup}
              renamingSessionId={renamingSessionId}
              onToggle={onToggle}
              onConnect={onConnect}
              onOpenSftp={onOpenSftp}
              onEdit={onEdit}
              onDeleteSession={onDeleteSession}
              onDuplicateSession={onDuplicateSession}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onNewSubgroup={onNewSubgroup}
              onRenameGroup={onRenameGroup}
              onDeleteGroup={onDeleteGroup}
              t={t}
            />
          ))}

          {/* Sessions in this group */}
          {groupSessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              depth={depth + 1}
              renaming={renamingSessionId === s.id}
              onConnect={() => onConnect(s)}
              onOpenSftp={() => onOpenSftp(s)}
              onEdit={() => onEdit(s.id)}
              onDelete={() => onDeleteSession(s)}
              onDuplicate={() => onDuplicateSession(s)}
              onStartRename={() => onStartRename(s.id)}
              onCommitRename={(name) => onCommitRename(s, name)}
              t={t}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ── Session row ──────────────────────────────────────────────────────────

interface RowProps {
  session: Session;
  depth: number;
  renaming: boolean;
  onConnect: () => void;
  onOpenSftp: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function SessionRow({
  session,
  depth,
  renaming,
  onConnect,
  onOpenSftp,
  onEdit,
  onDelete,
  onDuplicate,
  onStartRename,
  onCommitRename,
  t,
}: RowProps) {
  const paddingLeft = 20 + depth * 16;
  const inputRef = useRef<HTMLInputElement>(null);
  const [renameValue, setRenameValue] = useState(session.name);
  // Guard against false blur right after rename mode activates
  const readyRef = useRef(false);

  useEffect(() => {
    if (renaming) {
      readyRef.current = false;
      setRenameValue(session.name);
      // Delay focus+select so the input is fully mounted and blur guard is set
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
        readyRef.current = true;
      }, 60);
      return () => clearTimeout(t);
    }
  }, [renaming, session.name]);

  const commitRename = () => {
    if (!readyRef.current) return; // ignore spurious blur before input is ready
    onCommitRename(renameValue);
  };

  const row = (
    <div
      role="button"
      tabIndex={0}
      onClick={onConnect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onConnect();
        }
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-left text-sm",
        "hover:bg-bg-overlay",
      )}
      style={{ paddingLeft }}
    >
      <Server className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            ref={inputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") onCommitRename(session.name);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded border border-accent bg-bg-elevated px-1 py-0.5 text-xs text-fg outline-none"
          />
        ) : (
          <>
            <div className="truncate text-fg">{session.name}</div>
            <div className="truncate text-xs text-fg-muted">
              {session.username}@{session.host}
              {session.port !== 22 ? `:${session.port}` : ""}
            </div>
          </>
        )}
      </div>
      {!renaming && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSftp();
            }}
            className="rounded p-1 text-fg-subtle opacity-0 hover:text-accent group-hover:opacity-100"
            title={t("sidebar.openSftp")}
            aria-label={t("sidebar.openSftp")}
          >
            <FolderOpen className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="rounded p-1 text-fg-subtle opacity-0 hover:text-accent group-hover:opacity-100"
            title={t("sidebar.editSession")}
            aria-label={t("sidebar.editSession")}
          >
            <Pencil className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-[160px] rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-xl">
          <ContextMenu.Item
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
            onSelect={onConnect}
          >
            <Server className="mr-1.5 inline h-3 w-3" />
            {t("sidebar.connect")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
            onSelect={onOpenSftp}
          >
            <FolderOpen className="mr-1.5 inline h-3 w-3" />
            {t("sidebar.openSftp")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
            onSelect={onEdit}
          >
            <Pencil className="mr-1.5 inline h-3 w-3" />
            {t("sidebar.editSession")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
            onSelect={onStartRename}
          >
            <TextCursorInput className="mr-1.5 inline h-3 w-3" />
            {t("sidebar.renameSession")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-fg outline-none hover:bg-bg-overlay"
            onSelect={onDuplicate}
          >
            <Copy className="mr-1.5 inline h-3 w-3" />
            {t("sidebar.duplicateSession")}
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
          <ContextMenu.Item
            className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-danger outline-none hover:bg-danger/10"
            onSelect={onDelete}
          >
            <Trash2 className="mr-1.5 inline h-3 w-3" />
            {t("sidebar.deleteSession")}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
