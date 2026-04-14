import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDownUp, Check, Code2, FolderSearch, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { secretsApi } from "@/api/secrets";
import type { Script, ScriptInput } from "@/api/scripts";
import { scriptsApi } from "@/api/scripts";
import { portForwardsApi } from "@/api/sessions";
import type { AuthMethod, Group, PortForward, PortForwardInput, PortForwardType, Session, SessionInput } from "@/api/types";
import { ScriptEditorDialog } from "@/components/dialogs/ScriptEditorDialog";
import type { ScriptEditorData } from "@/components/dialogs/ScriptEditorDialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";
import { formatError, useSessionsStore } from "@/stores/sessions";

/** Flatten group tree into a depth-annotated list for <select> rendering. */
function flattenGroupsForSelect(
  groups: Group[],
): { group: Group; depth: number }[] {
  const childrenOf = new Map<string | null, Group[]>();
  for (const g of groups) {
    const key = g.parentId ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(g);
  }
  const result: { group: Group; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const g of childrenOf.get(parentId) ?? []) {
      result.push({ group: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, dialog opens in edit mode. */
  session: Session | null;
}

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath: string;
  useKeychain: boolean;
  secret: string;
  description: string;
  groupId: string;
}

const EMPTY: FormState = {
  name: "",
  host: "",
  port: "22",
  username: "",
  authMethod: "password",
  privateKeyPath: "",
  useKeychain: true,
  secret: "",
  description: "",
  groupId: "",
};

function fromSession(s: Session): FormState {
  return {
    name: s.name,
    host: s.host,
    port: String(s.port),
    username: s.username,
    authMethod: s.authMethod,
    privateKeyPath: s.privateKeyPath ?? "",
    useKeychain: s.useKeychain,
    secret: "",
    description: s.description ?? "",
    groupId: s.groupId ?? "",
  };
}

export function ConnectionDialog({ open, onOpenChange, session }: Props) {
  const { t } = useTranslation();
  const upsertSession = useSessionsStore((s) => s.upsertSession);
  const groups: Group[] = useSessionsStore((s) => s.groups);

  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasStoredSecret, setHasStoredSecret] = useState(false);

  // Per-session scripts
  const [sessionScripts, setSessionScripts] = useState<Script[]>([]);
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
  const [editingSessionScript, setEditingSessionScript] = useState<Script | null>(null);

  // Port forwards
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const loadSessionScripts = useCallback(async (sid: string) => {
    try {
      const list = await scriptsApi.listForSession(sid);
      setSessionScripts(list);
    } catch { /* ignore */ }
  }, []);

  const loadForwards = useCallback(async (sid: string) => {
    try {
      const list = await portForwardsApi.list(sid);
      setForwards(list);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!open) return;
    setForm(session ? fromSession(session) : EMPTY);
    setError(null);
    setSubmitting(false);
    setSessionScripts([]);
    setEditingSessionScript(null);
    setForwards([]);

    if (session) {
      secretsApi
        .has(session.id)
        .then(setHasStoredSecret)
        .catch(() => setHasStoredSecret(false));
      void loadSessionScripts(session.id);
      void loadForwards(session.id);
    } else {
      setHasStoredSecret(false);
    }
  }, [open, session, loadSessionScripts, loadForwards]);

  // Cleanup save timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of saveTimers.current.values()) clearTimeout(timer);
    };
  }, []);

  /** Debounced save of a forward rule (400ms). */
  const debouncedSaveForward = useCallback((fw: PortForward) => {
    const existing = saveTimers.current.get(fw.id);
    if (existing) clearTimeout(existing);
    saveTimers.current.set(
      fw.id,
      setTimeout(async () => {
        saveTimers.current.delete(fw.id);
        try {
          const input: PortForwardInput = {
            id: fw.id,
            sessionId: fw.sessionId,
            forwardType: fw.forwardType,
            label: fw.label,
            bindHost: fw.bindHost,
            bindPort: fw.bindPort,
            targetHost: fw.targetHost,
            targetPort: fw.targetPort,
            enabled: fw.enabled,
          };
          await portForwardsApi.upsert(input);
        } catch { /* silent */ }
      }, 400),
    );
  }, []);

  const addForward = async () => {
    if (!session) return;
    try {
      const created = await portForwardsApi.upsert({
        sessionId: session.id,
        forwardType: "local" as PortForwardType,
        bindHost: "127.0.0.1",
        bindPort: 8080,
        targetHost: "127.0.0.1",
        targetPort: 80,
        enabled: true,
      });
      setForwards((prev) => [...prev, created]);
    } catch { /* ignore */ }
  };

  const updateForward = (id: string, patch: Partial<PortForward>) => {
    setForwards((prev) =>
      prev.map((fw) => {
        if (fw.id !== id) return fw;
        const updated = { ...fw, ...patch };
        debouncedSaveForward(updated);
        return updated;
      }),
    );
  };

  /** Immediately save a forward (for toggles). */
  const saveForwardNow = async (fw: PortForward) => {
    try {
      await portForwardsApi.upsert({
        id: fw.id,
        sessionId: fw.sessionId,
        forwardType: fw.forwardType,
        label: fw.label,
        bindHost: fw.bindHost,
        bindPort: fw.bindPort,
        targetHost: fw.targetHost,
        targetPort: fw.targetPort,
        enabled: fw.enabled,
      });
    } catch { /* silent */ }
  };

  const toggleForward = (id: string) => {
    setForwards((prev) =>
      prev.map((fw) => {
        if (fw.id !== id) return fw;
        const updated = { ...fw, enabled: !fw.enabled };
        void saveForwardNow(updated);
        return updated;
      }),
    );
  };

  const deleteForward = async (id: string) => {
    try {
      await portForwardsApi.remove(id);
      setForwards((prev) => prev.filter((fw) => fw.id !== id));
    } catch { /* ignore */ }
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const browseKeyFile = async () => {
    const selected = await openFileDialog({
      title: t("dialog.selectKeyFile"),
      multiple: false,
      filters: [
        { name: "SSH Keys", extensions: ["pem", "key", "ppk", "pub"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (selected) {
      update("privateKeyPath", selected);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const name = form.name.trim();
    const host = form.host.trim();
    const username = form.username.trim();
    const portNum = Number.parseInt(form.port, 10);

    if (!name || !host || !username) {
      setError(t("dialog.nameHostRequired"));
      return;
    }
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      setError(t("dialog.portRange"));
      return;
    }

    const input: SessionInput = {
      id: session?.id,
      groupId: form.groupId || null,
      name,
      host,
      port: portNum,
      username,
      authMethod: form.authMethod,
      privateKeyPath:
        form.authMethod === "key"
          ? form.privateKeyPath.trim() || null
          : null,
      useKeychain: form.useKeychain,
      description: form.description.trim() || null,
      color: session?.color ?? null,
    };

    setSubmitting(true);
    try {
      const saved = await upsertSession(input);
      await syncSecret(saved.id);
      onOpenChange(false);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setSubmitting(false);
    }
  };

  async function syncSecret(sessionId: string): Promise<void> {
    if (form.authMethod === "agent" || !form.useKeychain) {
      await secretsApi.clear(sessionId);
      return;
    }
    if (form.secret.length > 0) {
      await secretsApi.set(sessionId, form.secret);
    }
  }

  const showSecretField = form.useKeychain && form.authMethod !== "agent";
  const secretLabel =
    form.authMethod === "password"
      ? t("dialog.password")
      : t("dialog.keyPassphrase");
  const placeholder =
    session && hasStoredSecret
      ? t("dialog.keepStoredSecret")
      : form.authMethod === "password"
        ? t("dialog.placeholderPassword")
        : t("dialog.placeholderPassphrase");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[480px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-bg-elevated shadow-2xl focus:outline-none">
          <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
            <Dialog.Title className="text-sm font-medium text-fg">
              {session ? t("dialog.editSession") : t("dialog.newSession")}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded p-1 text-fg-muted hover:bg-bg-overlay hover:text-fg"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <Dialog.Description className="sr-only">
            {t("dialog.fillDetails")}
          </Dialog.Description>

          <form
            onSubmit={handleSubmit}
            className="grid grid-cols-2 gap-3 overflow-y-auto px-5 py-4"
          >
            <div className="col-span-2 space-y-1">
              <Label htmlFor="session-name">{t("dialog.name")}</Label>
              <Input
                id="session-name"
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder={t("dialog.placeholderName")}
                autoFocus
              />
            </div>

            <div className="col-span-2 grid grid-cols-[1fr_88px] gap-2">
              <div className="space-y-1">
                <Label htmlFor="session-host">{t("dialog.host")}</Label>
                <Input
                  id="session-host"
                  value={form.host}
                  onChange={(e) => update("host", e.target.value)}
                  placeholder={t("dialog.placeholderHost")}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="session-port">{t("dialog.port")}</Label>
                <Input
                  id="session-port"
                  inputMode="numeric"
                  value={form.port}
                  onChange={(e) => update("port", e.target.value)}
                />
              </div>
            </div>

            <div className="col-span-2 space-y-1">
              <Label htmlFor="session-user">{t("dialog.username")}</Label>
              <Input
                id="session-user"
                value={form.username}
                onChange={(e) => update("username", e.target.value)}
                placeholder={t("dialog.placeholderUser")}
              />
            </div>

            {/* Group picker */}
            {groups.length > 0 && (
              <div className="col-span-2 space-y-1">
                <Label htmlFor="session-group">{t("dialog.groupId")}</Label>
                <Select
                  id="session-group"
                  value={form.groupId}
                  onChange={(e) => update("groupId", e.target.value)}
                >
                  <option value="">{t("dialog.noGroup")}</option>
                  {flattenGroupsForSelect(groups).map(({ group, depth }) => (
                    <option key={group.id} value={group.id}>
                      {"\u00A0\u00A0".repeat(depth)}{depth > 0 ? "└ " : ""}{group.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="col-span-2 space-y-1">
              <Label htmlFor="session-auth">{t("dialog.authentication")}</Label>
              <Select
                id="session-auth"
                value={form.authMethod}
                onChange={(e) =>
                  update("authMethod", e.target.value as AuthMethod)
                }
              >
                <option value="password">{t("dialog.password")}</option>
                <option value="key">{t("dialog.privateKey")}</option>
                <option value="agent">{t("dialog.sshAgent")}</option>
              </Select>
            </div>

            {form.authMethod === "key" && (
              <div className="col-span-2 space-y-1">
                <Label htmlFor="session-keypath">
                  {t("dialog.privateKeyPath")}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="session-keypath"
                    value={form.privateKeyPath}
                    onChange={(e) => update("privateKeyPath", e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void browseKeyFile()}
                    title={t("dialog.browseKey")}
                  >
                    <FolderSearch className="h-3.5 w-3.5" />
                    {t("dialog.browseKey")}
                  </Button>
                </div>
              </div>
            )}

            {form.authMethod !== "agent" && (
              <label className="col-span-2 mt-1 flex items-center gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked={form.useKeychain}
                  onChange={(e) => update("useKeychain", e.target.checked)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                {t("dialog.storeInKeychain", {
                  type:
                    form.authMethod === "password"
                      ? t("dialog.password").toLowerCase()
                      : t("dialog.keyPassphrase").toLowerCase(),
                })}
              </label>
            )}

            {showSecretField && (
              <div className="col-span-2 space-y-1">
                <div className="flex items-center justify-between">
                  <Label htmlFor="session-secret">{secretLabel}</Label>
                  {hasStoredSecret && form.secret.length === 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-success">
                      <Check className="h-3 w-3" /> {t("dialog.stored")}
                    </span>
                  )}
                </div>
                <Input
                  id="session-secret"
                  type="password"
                  autoComplete="new-password"
                  value={form.secret}
                  onChange={(e) => update("secret", e.target.value)}
                  placeholder={placeholder}
                />
              </div>
            )}

            <div className="col-span-2 space-y-1">
              <Label htmlFor="session-desc">{t("dialog.description")}</Label>
              <Input
                id="session-desc"
                value={form.description}
                onChange={(e) => update("description", e.target.value)}
                placeholder={t("dialog.placeholderDesc")}
              />
            </div>

            {/* Per-session scripts (only in edit mode) */}
            {session && (
              <div className="col-span-2 mt-1 space-y-2 border-t border-border-subtle pt-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Code2 className="h-3.5 w-3.5 text-fg-subtle" />
                    <span className="text-xs font-medium text-fg">{t("settings.scriptsSession")}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingSessionScript(null);
                      setScriptEditorOpen(true);
                    }}
                    className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent/90"
                  >
                    <Plus className="h-3 w-3" />
                    {t("settings.addScript")}
                  </button>
                </div>
                <p className="text-[11px] text-fg-muted">{t("settings.scriptsSessionDesc")}</p>

                {/* Existing scripts */}
                {sessionScripts.map((sc) => {
                  const isMultiline = sc.command.includes("\n");
                  const preview = isMultiline ? sc.command.split("\n")[0] + " ..." : sc.command;
                  return (
                    <div
                      key={sc.id}
                      className="group flex items-center gap-1.5 rounded border border-border-subtle px-2 py-1.5 transition-colors hover:border-fg-subtle cursor-pointer"
                      onDoubleClick={() => {
                        setEditingSessionScript(sc);
                        setScriptEditorOpen(true);
                      }}
                    >
                      <span className="text-[11px] font-medium text-fg">{sc.name}</span>
                      {isMultiline && (
                        <span className="rounded bg-fg-muted/10 px-1 py-0.5 text-[9px] text-fg-subtle">
                          multi
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-muted">{preview}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSessionScript(sc);
                          setScriptEditorOpen(true);
                        }}
                        className="rounded p-0.5 text-fg-subtle opacity-0 hover:text-accent group-hover:opacity-100"
                        title={t("settings.editScript")}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await scriptsApi.delete(sc.id);
                          setSessionScripts((prev) => prev.filter((s) => s.id !== sc.id));
                        }}
                        className="rounded p-0.5 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
                        title={t("settings.deleteScript")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}

                {sessionScripts.length === 0 && (
                  <p className="py-2 text-center text-[11px] text-fg-muted">{t("settings.noScripts")}</p>
                )}

                <ScriptEditorDialog
                  open={scriptEditorOpen}
                  onOpenChange={setScriptEditorOpen}
                  initial={editingSessionScript ? { name: editingSessionScript.name, command: editingSessionScript.command } : undefined}
                  onSave={async (data: ScriptEditorData) => {
                    const input: ScriptInput = {
                      id: editingSessionScript?.id,
                      sessionId: session.id,
                      name: data.name,
                      command: data.command,
                    };
                    const result = await scriptsApi.upsert(input);
                    if (editingSessionScript) {
                      setSessionScripts((prev) => prev.map((s) => (s.id === result.id ? result : s)));
                    } else {
                      setSessionScripts((prev) => [...prev, result]);
                    }
                  }}
                />
              </div>
            )}

            {/* Port forwarding (only in edit mode) */}
            {session && (
              <div className="col-span-2 mt-1 space-y-2 border-t border-border-subtle pt-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <ArrowDownUp className="h-3.5 w-3.5 text-fg-subtle" />
                    <span className="text-xs font-medium text-fg">{t("dialog.portForwarding")}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void addForward()}
                    className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent/90"
                  >
                    <Plus className="h-3 w-3" />
                    {t("dialog.addForward")}
                  </button>
                </div>
                <p className="text-[11px] text-fg-muted">{t("dialog.portForwardingDesc")}</p>

                {forwards.map((fw) => (
                  <div
                    key={fw.id}
                    className="group flex flex-wrap items-center gap-1.5 rounded border border-border-subtle px-2 py-1.5 transition-colors hover:border-fg-subtle"
                  >
                    {/* Type selector */}
                    <select
                      value={fw.forwardType}
                      onChange={(e) => updateForward(fw.id, { forwardType: e.target.value as PortForwardType })}
                      className="h-6 rounded border border-border-subtle bg-bg-elevated px-1 text-[11px] text-fg focus:border-accent focus:outline-none"
                    >
                      <option value="local">{t("dialog.forwardLocal")}</option>
                      <option value="remote">{t("dialog.forwardRemote")}</option>
                    </select>

                    {/* Bind host:port */}
                    <input
                      value={fw.bindHost}
                      onChange={(e) => updateForward(fw.id, { bindHost: e.target.value })}
                      placeholder="127.0.0.1"
                      className="h-6 w-[90px] rounded border border-border-subtle bg-bg-elevated px-1.5 font-mono text-[11px] text-fg placeholder:text-fg-muted/50 focus:border-accent focus:outline-none"
                    />
                    <span className="text-[11px] text-fg-muted">:</span>
                    <input
                      inputMode="numeric"
                      value={fw.bindPort}
                      onChange={(e) => {
                        const v = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(v) && v >= 0 && v <= 65535) updateForward(fw.id, { bindPort: v });
                      }}
                      placeholder="8080"
                      className="h-6 w-[52px] rounded border border-border-subtle bg-bg-elevated px-1.5 font-mono text-[11px] text-fg placeholder:text-fg-muted/50 focus:border-accent focus:outline-none"
                    />

                    <span className="text-[11px] text-fg-muted">→</span>

                    {/* Target host:port */}
                    <input
                      value={fw.targetHost}
                      onChange={(e) => updateForward(fw.id, { targetHost: e.target.value })}
                      placeholder="127.0.0.1"
                      className="h-6 w-[90px] rounded border border-border-subtle bg-bg-elevated px-1.5 font-mono text-[11px] text-fg placeholder:text-fg-muted/50 focus:border-accent focus:outline-none"
                    />
                    <span className="text-[11px] text-fg-muted">:</span>
                    <input
                      inputMode="numeric"
                      value={fw.targetPort}
                      onChange={(e) => {
                        const v = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(v) && v >= 0 && v <= 65535) updateForward(fw.id, { targetPort: v });
                      }}
                      placeholder="80"
                      className="h-6 w-[52px] rounded border border-border-subtle bg-bg-elevated px-1.5 font-mono text-[11px] text-fg placeholder:text-fg-muted/50 focus:border-accent focus:outline-none"
                    />

                    {/* Enabled toggle + delete */}
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => toggleForward(fw.id)}
                        className={`h-5 w-8 shrink-0 rounded-full transition-colors ${fw.enabled ? "bg-accent" : "bg-fg-muted/30"}`}
                        title={fw.enabled ? t("session.enabled") : t("session.off")}
                      >
                        <span
                          className={`block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${fw.enabled ? "translate-x-3.5" : "translate-x-0.5"}`}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteForward(fw.id)}
                        className="rounded p-0.5 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
                        title={t("dialog.deleteForward")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}

                {forwards.length === 0 && (
                  <p className="py-2 text-center text-[11px] text-fg-muted">{t("dialog.noForwards")}</p>
                )}
              </div>
            )}

            {error && (
              <div className="col-span-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </div>
            )}

            <div className="col-span-2 mt-2 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">
                  {t("dialog.cancel")}
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={submitting}>
                {submitting
                  ? t("dialog.saving")
                  : session
                    ? t("dialog.save")
                    : t("dialog.create")}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

