import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Database, FileDown, FileUp, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { mobaApi, groupsApi, type MobaSession } from "@/api/sessions";
import { Button } from "@/components/ui/Button";
import { formatError, useSessionsStore } from "@/stores/sessions";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Source = "registry" | "file";

export function ImportMobaDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const [source, setSource] = useState<Source>("file");
  const [entries, setEntries] = useState<MobaSession[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [createGroups, setCreateGroups] = useState(true);
  const existingSessions = useSessionsStore((s) => s.sessions);
  const upsertSession = useSessionsStore((s) => s.upsertSession);
  const reloadStore = useSessionsStore((s) => s.load);

  // Reset when opened
  useEffect(() => {
    if (!open) return;
    setEntries([]);
    setSelected(new Set());
    setError(null);
    setImportedCount(0);
    setLoading(false);
  }, [open]);

  const loadFromRegistry = async () => {
    setLoading(true);
    setError(null);
    setEntries([]);
    try {
      const result = await mobaApi.importSessions();
      setEntries(result);
      setSelected(new Set(result.map((_, i) => i)));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  };

  const loadFromFile = async () => {
    setError(null);
    const filePath = await openFileDialog({
      title: t("import.mobaSelectFile"),
      filters: [{ name: "MobaXTerm Sessions", extensions: ["mxtsessions"] }],
    });
    if (!filePath) return;

    setLoading(true);
    setEntries([]);
    try {
      const result = await mobaApi.importFromFile(filePath);
      setEntries(result);
      setSelected(new Set(result.map((_, i) => i)));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSourceChange = (s: Source) => {
    setSource(s);
    setEntries([]);
    setSelected(new Set());
    setError(null);
    setImportedCount(0);
    if (s === "registry") void loadFromRegistry();
  };

  const toggle = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === entries.length) setSelected(new Set());
    else setSelected(new Set(entries.map((_, i) => i)));
  };

  const doImport = async () => {
    setImporting(true);
    let count = 0;

    // Collect unique groups from selected entries and create nested hierarchy.
    // e.g. "AEZA/STAGE" → create "AEZA" (root), then "STAGE" (child of AEZA).
    const groupMap = new Map<string, string>(); // full path → groupId
    if (createGroups) {
      const selectedEntries = [...selected].map((i) => entries[i]).filter(Boolean);
      const uniquePaths = new Set(
        selectedEntries.map((e) => e.group).filter((g): g is string => !!g),
      );

      // Collect all intermediate paths too (e.g. "A/B/C" → ["A", "A/B", "A/B/C"])
      const allPaths = new Set<string>();
      for (const path of uniquePaths) {
        const parts = path.split("/");
        for (let i = 1; i <= parts.length; i++) {
          allPaths.add(parts.slice(0, i).join("/"));
        }
      }

      // Sort by depth (shallow first) so parents are created before children
      const sorted = [...allPaths].sort((a, b) => {
        const da = a.split("/").length;
        const db = b.split("/").length;
        return da - db || a.localeCompare(b);
      });

      for (const fullPath of sorted) {
        const parts = fullPath.split("/");
        const name = parts[parts.length - 1];
        const parentPath = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
        const parentId = parentPath ? (groupMap.get(parentPath) ?? null) : null;
        try {
          const created = await groupsApi.upsert({ name, parentId });
          groupMap.set(fullPath, created.id);
        } catch {
          /* skip */
        }
      }
    }

    // Build set of existing sessions for dedup (host:port:username)
    const existingKeys = new Set(
      existingSessions.map((s) => `${s.host}:${s.port}:${s.username}`),
    );

    for (const idx of selected) {
      const e = entries[idx];
      if (!e) continue;
      // Skip if session with same host+port+username already exists
      if (existingKeys.has(`${e.host}:${e.port}:${e.username}`)) continue;
      const hasKey = !!e.privateKeyPath;
      const groupId = e.group ? (groupMap.get(e.group) ?? null) : null;
      try {
        await upsertSession({
          name: e.name,
          host: e.host,
          port: e.port,
          username: e.username,
          authMethod: hasKey ? "key" : "password",
          privateKeyPath: e.privateKeyPath,
          useKeychain: false,
          groupId,
          description: e.group ? `MobaXTerm / ${e.group}` : "Imported from MobaXTerm",
          color: null,
        });
        existingKeys.add(`${e.host}:${e.port}:${e.username}`);
        count++;
      } catch {
        /* skip */
      }
    }

    // Reload sessions+groups in the store so sidebar shows them
    if (count > 0) {
      void reloadStore();
    }

    setImportedCount(count);
    setImporting(false);
    if (count > 0) setTimeout(() => onOpenChange(false), 800);
  };

  // Distinct groups in current entries
  const groupsInEntries = [...new Set(entries.map((e) => e.group).filter(Boolean))];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-bg-elevated p-6 shadow-xl">
          <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg">
            <FileDown className="h-5 w-5 text-accent" />
            {t("import.mobaTitle")}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-muted">
            {t("import.mobaDesc")}
          </Dialog.Description>

          {/* Source selector */}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => handleSourceChange("registry")}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors ${
                source === "registry"
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border-subtle text-fg-muted hover:border-fg-subtle hover:text-fg"
              }`}
            >
              <Database className="h-3.5 w-3.5" />
              {t("import.mobaFromRegistry")}
            </button>
            <button
              type="button"
              onClick={() => {
                setSource("file");
                void loadFromFile();
              }}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors ${
                source === "file"
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border-subtle text-fg-muted hover:border-fg-subtle hover:text-fg"
              }`}
            >
              <FileUp className="h-3.5 w-3.5" />
              {t("import.mobaFromFile")}
            </button>
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("import.mobaParsing")}
            </div>
          )}

          {error && (
            <div className="my-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && source === "registry" && (
            <div className="py-8 text-center text-sm text-fg-muted">
              {t("import.mobaNone")}
            </div>
          )}

          {!loading && entries.length > 0 && (
            <>
              <div className="mt-3 flex items-center justify-between text-xs text-fg-muted">
                <button type="button" onClick={toggleAll} className="text-accent hover:text-accent-hover">
                  {selected.size === entries.length ? t("import.deselectAll") : t("import.selectAll")}
                </button>
                <span>{t("import.selected", { count: selected.size, total: entries.length })}</span>
              </div>
              <ul className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border-subtle">
                {entries.map((e, i) => (
                  <li key={i} className="flex items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-0">
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} className="h-3.5 w-3.5 accent-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-fg">{e.name}</span>
                        {e.group && (
                          <span className="shrink-0 rounded bg-fg-muted/10 px-1 py-0.5 text-[9px] text-fg-subtle">
                            {e.group}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-fg-muted">
                        {e.username}@{e.host}{e.port !== 22 ? `:${e.port}` : ""}
                        {e.privateKeyPath ? ` (key)` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              {/* Create groups option */}
              {groupsInEntries.length > 0 && (
                <label className="mt-2 flex items-center gap-2 text-xs text-fg-muted">
                  <input
                    type="checkbox"
                    checked={createGroups}
                    onChange={() => setCreateGroups(!createGroups)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  {t("import.mobaCreateGroups")}
                  <span className="text-fg-subtle">({groupsInEntries.length})</span>
                </label>
              )}
            </>
          )}

          {importedCount > 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              {t("import.importedN", { count: importedCount })}
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={importing}>
              {t("dialog.cancel")}
            </Button>
            <Button type="button" variant="primary" size="sm" disabled={importing || selected.size === 0 || entries.length === 0} onClick={() => void doImport()}>
              {importing ? (
                <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />{t("import.importing")}</>
              ) : (
                t("import.importN", { count: selected.size })
              )}
            </Button>
          </div>

          <Dialog.Close asChild>
            <button type="button" className="absolute right-4 top-4 text-fg-subtle hover:text-fg" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
