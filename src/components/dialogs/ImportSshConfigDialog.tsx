import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FileDown, Loader2, X, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { configApi } from "@/api/sessions";
import type { SshConfigEntry } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { DraggableDialogContent } from "@/components/ui/DraggableDialogContent";
import { useSessionsStore } from "@/stores/sessions";
import { formatError } from "@/stores/sessions";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog that reads `~/.ssh/config`, shows discovered Host entries, and lets
 * the user pick which ones to import as sessions.
 */
export function ImportSshConfigDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<SshConfigEntry[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const existingSessions = useSessionsStore((s) => s.sessions);
  const upsertSession = useSessionsStore((s) => s.upsertSession);

  useEffect(() => {
    if (!open) return;
    setEntries([]);
    setSelected(new Set());
    setError(null);
    setImportedCount(0);
    setLoading(true);

    configApi
      .importSshConfig()
      .then((result) => {
        setEntries(result);
        // Select all by default
        setSelected(new Set(result.map((_, i) => i)));
      })
      .catch((e) => setError(formatError(e)))
      .finally(() => setLoading(false));
  }, [open]);

  const toggle = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === entries.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(entries.map((_, i) => i)));
    }
  };

  const doImport = async () => {
    setImporting(true);
    let count = 0;
    // Build set of existing sessions for dedup (host:port:username)
    const existingKeys = new Set(
      existingSessions.map((s) => `${s.host}:${s.port}:${s.username}`),
    );
    for (const idx of selected) {
      const e = entries[idx];
      if (!e) continue;
      const host = e.host ?? e.alias;
      const port = e.port ?? 22;
      const username = e.user ?? "root";
      // Skip if session with same host+port+username already exists
      if (existingKeys.has(`${host}:${port}:${username}`)) continue;
      const hasKey = !!e.identityFile;
      try {
        await upsertSession({
          name: e.alias,
          host,
          port,
          username,
          authMethod: hasKey ? "key" : "password",
          privateKeyPath: e.identityFile,
          useKeychain: false,
          groupId: null,
          description: `Imported from ~/.ssh/config`,
          color: null,
        });
        existingKeys.add(`${host}:${port}:${username}`);
        count++;
      } catch {
        // Skip failed ones silently — the user can see them in the list
      }
    }
    setImportedCount(count);
    setImporting(false);
    if (count > 0) {
      // Close after a brief delay so the user sees the success message
      setTimeout(() => onOpenChange(false), 800);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DraggableDialogContent className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-bg-elevated p-6 shadow-xl">
          <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg">
            <FileDown className="h-5 w-5 text-accent" />
            {t("import.title")}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-muted">
            {t("import.discovered")}
          </Dialog.Description>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("import.parsingSsh")}
            </div>
          )}

          {error && (
            <div className="my-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div className="py-8 text-center text-sm text-fg-muted">
              {t("import.noEntries")}
            </div>
          )}

          {!loading && entries.length > 0 && (
            <>
              <div className="mt-3 flex items-center justify-between text-xs text-fg-muted">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-accent hover:text-accent-hover"
                >
                  {selected.size === entries.length
                    ? t("import.deselectAll")
                    : t("import.selectAll")}
                </button>
                <span>
                  {t("import.selected", { count: selected.size, total: entries.length })}
                </span>
              </div>

              <ul className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border-subtle">
                {entries.map((e, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggle(i)}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-fg">
                        {e.alias}
                      </div>
                      <div className="truncate text-xs text-fg-muted">
                        {e.user ?? "?"}@{e.host ?? e.alias}
                        {e.port && e.port !== 22 ? `:${e.port}` : ""}
                        {e.identityFile ? ` (key: ${e.identityFile})` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {importedCount > 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              {t("import.importedN", { count: importedCount })}
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={importing}
            >
              {t("dialog.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={
                importing || selected.size === 0 || entries.length === 0
              }
              onClick={() => void doImport()}
            >
              {importing ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t("import.importing")}
                </>
              ) : (
                t("import.importN", { count: selected.size })
              )}
            </Button>
          </div>

          <Dialog.Close asChild>
            <button
              type="button"
              className="absolute right-4 top-4 text-fg-subtle hover:text-fg"
              aria-label={t("titlebar.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </DraggableDialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
