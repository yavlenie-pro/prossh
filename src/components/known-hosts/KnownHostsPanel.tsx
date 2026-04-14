import { useEffect, useState } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { KnownHostEntry } from "@/api/knownHosts";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useKnownHostsStore } from "@/stores/knownHosts";

/**
 * Read-only list of trusted SSH host keys. Users can revoke individual
 * entries or wipe everything for a host:port pair. New entries get added
 * automatically by the SSH connect flow in step 5+.
 */
export function KnownHostsPanel() {
  const { t } = useTranslation();
  const entries = useKnownHostsStore((s) => s.entries);
  const loading = useKnownHostsStore((s) => s.loading);
  const error = useKnownHostsStore((s) => s.error);
  const load = useKnownHostsStore((s) => s.load);
  const remove = useKnownHostsStore((s) => s.remove);
  const clearHost = useKnownHostsStore((s) => s.clearHost);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRemove = (entry: KnownHostEntry) => {
    const key = entryKey(entry);
    if (confirmingId !== key) {
      setConfirmingId(key);
      window.setTimeout(() => {
        setConfirmingId((current) => (current === key ? null : current));
      }, 3000);
      return;
    }
    void remove(entry.host, entry.port, entry.algorithm);
    setConfirmingId(null);
  };

  const handleClearHost = (host: string, port: number) => {
    if (confirm(t("knownHosts.revokeConfirm", { host, port }))) {
      void clearHost(host, port);
    }
  };

  // Group entries by host:port so the UI can offer a "clear host" shortcut.
  const grouped = groupByHost(entries);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
            <ShieldCheck className="h-4 w-4 text-accent" /> {t("knownHosts.title")}
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            {t("knownHosts.description")}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? t("knownHosts.reloading") : t("knownHosts.reload")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="mx-4 my-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {!loading && entries.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-xs text-fg-muted">
            <ShieldCheck className="h-8 w-8 text-fg-subtle" />
            <div>{t("knownHosts.empty")}</div>
            <div className="max-w-xs text-fg-subtle">
              {t("knownHosts.emptyHint")}
            </div>
          </div>
        )}

        {grouped.map(({ host, port, items }) => (
          <div key={`${host}:${port}`} className="border-b border-border-subtle">
            <div className="flex items-center justify-between bg-bg px-4 py-1.5">
              <div className="font-mono text-xs text-fg">
                {host}
                {port !== 22 && (
                  <span className="text-fg-muted">:{port}</span>
                )}
              </div>
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleClearHost(host, port)}
                  className="text-[10px] uppercase tracking-wider text-fg-muted hover:text-danger"
                >
                  {t("knownHosts.clearHost", { count: items.length })}
                </button>
              )}
            </div>
            {items.map((entry) => {
              const confirming = confirmingId === entryKey(entry);
              return (
                <div
                  key={entryKey(entry)}
                  className="flex items-start justify-between gap-3 px-4 py-2 hover:bg-bg-overlay/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="rounded bg-bg-overlay px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
                        {entry.algorithm}
                      </span>
                      <span className="text-fg-subtle">
                        {t("knownHosts.added", { date: formatDate(entry.addedAt) })}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-fg">
                      {entry.fingerprint}
                    </div>
                    {entry.comment && (
                      <div className="mt-1 text-xs text-fg-muted">
                        {entry.comment}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(entry)}
                    title={confirming ? t("knownHosts.clickConfirm") : t("knownHosts.revoke")}
                    className={cn(
                      "inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[11px] transition-colors",
                      confirming
                        ? "bg-danger/20 text-danger"
                        : "text-fg-subtle hover:bg-danger/15 hover:text-danger",
                    )}
                  >
                    <Trash2 className="h-3 w-3" />
                    {confirming ? t("knownHosts.confirm") : t("knownHosts.revoke")}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function entryKey(entry: KnownHostEntry): string {
  return `${entry.host}:${entry.port}:${entry.algorithm}`;
}

interface Group {
  host: string;
  port: number;
  items: KnownHostEntry[];
}

function groupByHost(entries: KnownHostEntry[]): Group[] {
  const map = new Map<string, Group>();
  for (const e of entries) {
    const key = `${e.host}:${e.port}`;
    let g = map.get(key);
    if (!g) {
      g = { host: e.host, port: e.port, items: [] };
      map.set(key, g);
    }
    g.items.push(e);
  }
  return Array.from(map.values());
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
