import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Activity, Code2, Copy, Globe, Info, Keyboard, Palette, Pencil, Plus, Search, Server, ShieldCheck, Terminal, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ColorProfile, Session } from "@/api/types";
import { settingsApi } from "@/api/settings";
import type { ScriptInput } from "@/api/scripts";
import { useScriptsStore } from "@/stores/scripts";
import { useSessionsStore } from "@/stores/sessions";
import { setLanguage } from "@/i18n";
import { KnownHostsPanel } from "@/components/known-hosts/KnownHostsPanel";
import { ConnectionDialog } from "@/components/dialogs/ConnectionDialog";
import { cn } from "@/lib/cn";
import { useThemeStore } from "@/stores/theme";
import { ScriptEditorDialog } from "@/components/dialogs/ScriptEditorDialog";
import type { ScriptEditorData } from "@/components/dialogs/ScriptEditorDialog";
import brandLogoEn from "@/assets/brand/proyavlenie-en.png";
import brandLogoRu from "@/assets/brand/proyavlenie-ru.png";
import { useAppVersion } from "@/hooks/useAppVersion";

type Tab = "sessions" | "known-hosts" | "appearance" | "terminal" | "monitoring" | "scripts" | "language" | "keyboard" | "about";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional initial tab (defaults to the first one). */
  initialTab?: Tab;
}

// Tab labels are resolved dynamically via i18n
const TAB_DEFS: { id: Tab; labelKey: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "sessions", labelKey: "settings.sessions", icon: Server },
  { id: "known-hosts", labelKey: "settings.knownHosts", icon: ShieldCheck },
  { id: "appearance", labelKey: "settings.appearance", icon: Palette },
  { id: "terminal", labelKey: "settings.terminal", icon: Terminal },
  { id: "monitoring", labelKey: "settings.monitoring", icon: Activity },
  { id: "scripts", labelKey: "settings.scripts", icon: Code2 },
  { id: "language", labelKey: "settings.language", icon: Globe },
  { id: "keyboard", labelKey: "settings.keyboard", icon: Keyboard },
  { id: "about", labelKey: "settings.about", icon: Info },
];

/**
 * Full-screen-ish modal for everything that doesn't belong in the sessions
 * sidebar. Starts small (known hosts + about) and grows as color profiles /
 * preferences / shortcuts land in later steps.
 */
export function SettingsDialog({ open, onOpenChange, initialTab = "sessions" }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(640px,85vh)] w-[min(820px,90vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl focus:outline-none">
          <Dialog.Title className="sr-only">{t("settings.title")}</Dialog.Title>
          <Dialog.Description className="sr-only">
            {t("settings.title")}
          </Dialog.Description>

          <nav className="flex w-48 shrink-0 flex-col border-r border-border-subtle bg-bg py-3">
            <div className="mb-2 px-4 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
              {t("settings.title")}
            </div>
            {TAB_DEFS.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "mx-2 flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                  tab === id
                    ? "bg-bg-overlay text-fg"
                    : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(labelKey)}
              </button>
            ))}
          </nav>

          <div className="relative flex min-w-0 flex-1 flex-col pr-8">
            <Dialog.Close asChild>
              <button
                type="button"
                className="absolute right-1 top-3 z-10 rounded p-1 text-fg-muted hover:bg-bg-overlay hover:text-fg"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>

            {tab === "sessions" && <SessionsPanel />}
            {tab === "known-hosts" && <KnownHostsPanel />}
            {tab === "appearance" && <AppearancePanel />}
            {tab === "terminal" && <TerminalPanel />}
            {tab === "monitoring" && <MonitoringPanel />}
            {tab === "scripts" && <ScriptsPanel />}
            {tab === "language" && <LanguagePanel />}
            {tab === "keyboard" && <KeyboardPanel />}
            {tab === "about" && <AboutPanel />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SessionsPanel() {
  const { t } = useTranslation();
  const sessions = useSessionsStore((s) => s.sessions);
  const groups = useSessionsStore((s) => s.groups);
  const load = useSessionsStore((s) => s.load);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const duplicateSession = useSessionsStore((s) => s.duplicateSession);

  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingSession(null);
    setDialogOpen(true);
  };

  const openEdit = (s: Session) => {
    setEditingSession(s);
    setDialogOpen(true);
  };

  const groupName = (groupId: string | null) => {
    if (!groupId) return null;
    return groups.find((g) => g.id === groupId)?.name ?? null;
  };

  // Filter sessions by search query
  const query = search.trim().toLowerCase();
  const filtered = query
    ? sessions.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.host.toLowerCase().includes(query) ||
          s.username.toLowerCase().includes(query),
      )
    : sessions;

  return (
    <div className="flex h-full flex-col overflow-hidden p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">{t("settings.sessions")}</h2>
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-hover"
        >
          <Plus className="h-3 w-3" /> {t("sidebar.newSession")}
        </button>
      </div>

      {/* Search input */}
      {sessions.length > 0 && (
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("settings.searchSessions")}
            className="w-full rounded-lg border border-border-subtle bg-bg py-1.5 pl-7 pr-7 text-xs text-fg placeholder:text-fg-subtle outline-none focus:border-accent"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-subtle hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-subtle">
        {sessions.length === 0 ? (
          <div className="py-10 text-center text-xs text-fg-muted">{t("sidebar.noSessions")}</div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-xs text-fg-muted">{t("palette.noResults")}</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-subtle text-left text-fg-muted">
                <th className="px-3 py-2 font-medium">{t("session.host")}</th>
                <th className="px-3 py-2 font-medium">{t("session.user")}</th>
                <th className="px-3 py-2 font-medium">Port</th>
                <th className="px-3 py-2 font-medium">{t("sidebar.sessions")}</th>
                <th className="w-20 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className="border-b border-border-subtle last:border-0 hover:bg-bg-overlay/50">
                  <td className="px-3 py-1.5 text-fg">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-fg-muted">{s.host}</div>
                  </td>
                  <td className="px-3 py-1.5 text-fg-muted">{s.username}</td>
                  <td className="px-3 py-1.5 tabular-nums text-fg-muted">{s.port}</td>
                  <td className="px-3 py-1.5">
                    {groupName(s.groupId) && (
                      <span className="rounded bg-fg-muted/10 px-1.5 py-0.5 text-[10px] text-fg-subtle">
                        {groupName(s.groupId)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(s)}
                        className="rounded p-1 text-fg-subtle hover:text-accent"
                        title={t("sidebar.editSession")}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void duplicateSession(s)}
                        className="rounded p-1 text-fg-subtle hover:text-accent"
                        title={t("sidebar.duplicateSession")}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(t("sidebar.deleteConfirm", { name: s.name }))) {
                            void deleteSession(s.id);
                          }
                        }}
                        className="rounded p-1 text-fg-subtle hover:text-danger"
                        title={t("sidebar.deleteSession")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        session={editingSession}
      />
    </div>
  );
}

function AppearancePanel() {
  const { t } = useTranslation();
  const profiles = useThemeStore((s) => s.profiles);
  const activeId = useThemeStore((s) => s.activeProfileId);
  const setActive = useThemeStore((s) => s.setActive);
  const load = useThemeStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="p-5">
      <h3 className="text-sm font-semibold text-fg">{t("settings.colorProfile")}</h3>
      <p className="mt-1 text-xs text-fg-muted">
        {t("settings.colorProfileDesc")}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        {profiles.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            active={p.id === activeId}
            onSelect={() => void setActive(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ProfileCard({
  profile,
  active,
  onSelect,
}: {
  profile: ColorProfile;
  active: boolean;
  onSelect: () => void;
}) {
  const colors = [
    profile.black,
    profile.red,
    profile.green,
    profile.yellow,
    profile.blue,
    profile.magenta,
    profile.cyan,
    profile.white,
  ];

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-accent bg-accent/10"
          : "border-border-subtle hover:border-fg-subtle",
      )}
    >
      <div
        className="flex gap-1 rounded px-2 py-1.5"
        style={{ backgroundColor: profile.background }}
      >
        {colors.map((c, i) => (
          <div
            key={i}
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-fg">{profile.name}</span>
        {profile.isBuiltin && (
          <span className="text-[10px] text-fg-subtle">built-in</span>
        )}
      </div>
    </button>
  );
}

function TerminalPanel() {
  const { t } = useTranslation();
  const [rightClickPaste, setRightClickPaste] = useState(true);
  const [copyOnSelect, setCopyOnSelect] = useState(true);
  const [rememberSftpDir, setRememberSftpDir] = useState(true);
  const [restoreSessions, setRestoreSessions] = useState(false);
  const [autoSftpTab, setAutoSftpTab] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const [rcp, cos, rsd, rs, ast] = await Promise.all([
        settingsApi.get("terminal.rightClickPaste"),
        settingsApi.get("terminal.copyOnSelect"),
        settingsApi.get("sftp.rememberLastDir"),
        settingsApi.get("app.restoreSessions"),
        settingsApi.get("app.autoSftpTab"),
      ]);
      setRightClickPaste(rcp !== "false");
      setCopyOnSelect(cos !== "false");
      setRememberSftpDir(rsd !== "false");
      setRestoreSessions(rs === "true");
      setAutoSftpTab(ast === "true");
      setLoaded(true);
    })();
  }, []);

  const toggle = (key: string, value: boolean, setter: (v: boolean) => void) => {
    setter(value);
    void settingsApi.set(key, String(value));
  };

  if (!loaded) return null;

  return (
    <div className="p-5">
      <h3 className="text-sm font-semibold text-fg">{t("settings.terminal")}</h3>
      <p className="mt-1 text-xs text-fg-muted">
        {t("settings.terminalDesc")}
      </p>

      <div className="mt-4 space-y-3">
        <ToggleRow
          label={t("settings.rightClickPaste")}
          description={t("settings.rightClickPasteDesc")}
          checked={rightClickPaste}
          onChange={(v) => toggle("terminal.rightClickPaste", v, setRightClickPaste)}
        />
        <ToggleRow
          label={t("settings.copyOnSelect")}
          description={t("settings.copyOnSelectDesc")}
          checked={copyOnSelect}
          onChange={(v) => toggle("terminal.copyOnSelect", v, setCopyOnSelect)}
        />
        <ToggleRow
          label={t("settings.rememberSftpDir")}
          description={t("settings.rememberSftpDirDesc")}
          checked={rememberSftpDir}
          onChange={(v) => toggle("sftp.rememberLastDir", v, setRememberSftpDir)}
        />
        <ToggleRow
          label={t("settings.restoreSessions")}
          description={t("settings.restoreSessionsDesc")}
          checked={restoreSessions}
          onChange={(v) => toggle("app.restoreSessions", v, setRestoreSessions)}
        />
        <ToggleRow
          label={t("settings.autoSftpTab")}
          description={t("settings.autoSftpTabDesc")}
          checked={autoSftpTab}
          onChange={(v) => toggle("app.autoSftpTab", v, setAutoSftpTab)}
        />
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border-subtle px-4 py-3 transition-colors hover:border-fg-subtle">
      <div className="flex-1">
        <div className="text-xs font-medium text-fg">{label}</div>
        <div className="mt-0.5 text-[11px] text-fg-muted">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-accent" : "bg-fg-muted/30",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
            checked && "translate-x-4",
          )}
        />
      </button>
    </label>
  );
}

function ScriptsPanel() {
  const { t } = useTranslation();
  const scripts = useScriptsStore((s) => s.scripts);
  const loadGlobal = useScriptsStore((s) => s.loadGlobal);
  const upsert = useScriptsStore((s) => s.upsert);
  const remove = useScriptsStore((s) => s.remove);

  // Editor dialog state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<{ id: string; name: string; command: string } | null>(null);

  useEffect(() => {
    void loadGlobal();
  }, [loadGlobal]);

  const globalScripts = scripts.filter((s) => s.sessionId === null);

  const handleNew = () => {
    setEditingScript(null);
    setEditorOpen(true);
  };

  const handleEdit = (script: { id: string; name: string; command: string }) => {
    setEditingScript(script);
    setEditorOpen(true);
  };

  const handleSave = async (data: ScriptEditorData) => {
    const input: ScriptInput = {
      id: editingScript?.id,
      sessionId: null,
      name: data.name,
      command: data.command,
    };
    await upsert(input);
  };

  return (
    <div className="flex h-full flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{t("settings.scripts")}</h3>
          <p className="mt-1 text-xs text-fg-muted">
            {t("settings.scriptsDesc")}
          </p>
        </div>
        <button
          type="button"
          onClick={handleNew}
          className="flex shrink-0 items-center gap-1 rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90"
        >
          <Plus className="h-3 w-3" />
          {t("settings.addScript")}
        </button>
      </div>

      {/* Script list */}
      <div className="mt-4 flex-1 space-y-1.5 overflow-y-auto">
        {globalScripts.length === 0 && (
          <p className="py-6 text-center text-xs text-fg-muted">{t("settings.noScripts")}</p>
        )}
        {globalScripts.map((script) => (
          <ScriptRow
            key={script.id}
            script={script}
            onEdit={() => handleEdit(script)}
            onDelete={() => void remove(script.id)}
          />
        ))}
      </div>

      <ScriptEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editingScript ? { name: editingScript.name, command: editingScript.command } : undefined}
        onSave={(data) => void handleSave(data)}
      />
    </div>
  );
}

function ScriptRow({
  script,
  onEdit,
  onDelete,
}: {
  script: { id: string; name: string; command: string };
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isMultiline = script.command.includes("\n");
  const preview = isMultiline
    ? script.command.split("\n")[0] + " ..."
    : script.command;

  return (
    <div
      className="group flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 transition-colors hover:border-fg-subtle cursor-pointer"
      onDoubleClick={onEdit}
    >
      <Code2 className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      <span className="text-xs font-medium text-fg">{script.name}</span>
      {isMultiline && (
        <span className="rounded bg-fg-muted/10 px-1 py-0.5 text-[9px] text-fg-subtle">
          multi
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
        {preview}
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="rounded p-0.5 text-fg-subtle opacity-0 hover:text-accent group-hover:opacity-100"
        title={t("settings.editScript")}
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="rounded p-0.5 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
        title={t("settings.deleteScript")}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

const INTERVAL_OPTIONS = [
  { value: 500, label: "0.5s" },
  { value: 1000, label: "1s" },
  { value: 2000, label: "2s" },
  { value: 3000, label: "3s" },
  { value: 5000, label: "5s" },
  { value: 10000, label: "10s" },
  { value: 15000, label: "15s" },
  { value: 30000, label: "30s" },
];

function IntervalSelect({
  label,
  description,
  value,
  minValue,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  minValue: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border-subtle px-4 py-3 transition-colors">
      <div className="flex-1">
        <div className="text-xs font-medium text-fg">{label}</div>
        <div className="mt-0.5 text-[11px] text-fg-muted">{description}</div>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-0.5 rounded border border-border-subtle bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent"
      >
        {INTERVAL_OPTIONS.filter((o) => o.value >= minValue).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function MonitoringPanel() {
  const { t } = useTranslation();
  const [fastMs, setFastMs] = useState(1000);
  const [slowMs, setSlowMs] = useState(5000);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const [fv, sv] = await Promise.all([
        settingsApi.get("monitoring.fastIntervalMs"),
        settingsApi.get("monitoring.slowIntervalMs"),
      ]);
      if (fv) {
        const n = parseInt(fv, 10);
        if (n >= 500) setFastMs(n);
      }
      if (sv) {
        const n = parseInt(sv, 10);
        if (n >= 1000) setSlowMs(n);
      }
      setLoaded(true);
    })();
  }, []);

  const updateFast = (v: number) => {
    setFastMs(v);
    void settingsApi.set("monitoring.fastIntervalMs", String(v));
  };

  const updateSlow = (v: number) => {
    setSlowMs(v);
    void settingsApi.set("monitoring.slowIntervalMs", String(v));
  };

  if (!loaded) return null;

  return (
    <div className="p-5">
      <h3 className="text-sm font-semibold text-fg">{t("settings.monitoring")}</h3>
      <p className="mt-1 text-xs text-fg-muted">
        {t("settings.monitoringDesc")}
      </p>

      <div className="mt-4 space-y-3">
        <IntervalSelect
          label={t("settings.fastInterval")}
          description={t("settings.fastIntervalDesc")}
          value={fastMs}
          minValue={500}
          onChange={updateFast}
        />
        <IntervalSelect
          label={t("settings.slowInterval")}
          description={t("settings.slowIntervalDesc")}
          value={slowMs}
          minValue={1000}
          onChange={updateSlow}
        />
      </div>
    </div>
  );
}

const SHORTCUT_DEFS = [
  { keys: "Ctrl+Shift+T", labelKey: "shortcuts.newTab" },
  { keys: "Ctrl+W", labelKey: "shortcuts.closeTab" },
  { keys: "Ctrl+Shift+D", labelKey: "shortcuts.splitH" },
  { keys: "Ctrl+Shift+E", labelKey: "shortcuts.splitV" },
  { keys: "Ctrl+Shift+P", labelKey: "shortcuts.palette" },
];

function LanguagePanel() {
  const { t, i18n } = useTranslation();
  const current = i18n.language;

  return (
    <div className="p-5">
      <h3 className="text-sm font-semibold text-fg">{t("settings.language")}</h3>
      <div className="mt-4 space-y-2">
        {[
          { code: "en", label: "English" },
          { code: "ru", label: "Русский" },
          { code: "zh", label: "中文" },
        ].map((lang) => (
          <button
            key={lang.code}
            type="button"
            onClick={() => setLanguage(lang.code)}
            className={cn(
              "flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors",
              current === lang.code
                ? "border-accent bg-accent/10"
                : "border-border-subtle hover:border-fg-subtle",
            )}
          >
            <span className="text-sm text-fg">{lang.label}</span>
            {current === lang.code && (
              <span className="text-xs text-accent">✓</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function KeyboardPanel() {
  const { t } = useTranslation();
  return (
    <div className="p-5">
      <h3 className="text-sm font-semibold text-fg">{t("settings.shortcuts")}</h3>
      <p className="mt-1 text-xs text-fg-muted">
        {t("settings.shortcutsReadOnly")}
      </p>
      <div className="mt-4 space-y-2">
        {SHORTCUT_DEFS.map((s) => (
          <div
            key={s.keys}
            className="flex items-center justify-between rounded-md border border-border-subtle px-3 py-2"
          >
            <span className="text-xs text-fg">{t(s.labelKey)}</span>
            <kbd className="rounded bg-bg-overlay px-2 py-0.5 font-mono text-xs text-fg-muted">
              {s.keys}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

function AboutPanel() {
  const { t, i18n } = useTranslation();
  // The brand logo has gold mark + navy text; sits on a light card so the
  // colors stay legible against the app's dark background. Picked by UI
  // language — Russian build uses the Cyrillic wordmark, everything else
  // falls back to the transliterated "Proyavlenie" version.
  const isRu = i18n.language?.toLowerCase().startsWith("ru");
  const brandLogo = isRu ? brandLogoRu : brandLogoEn;
  const version = useAppVersion();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="font-mono text-3xl tracking-wider text-fg">{t("app.name")}</div>
      <div className="font-mono text-xs text-fg-muted">
        {version ? `v${version}` : ""}
      </div>
      <div className="text-xs text-fg-muted">
        {t("app.tagline")}
      </div>
      <div className="text-[11px] text-fg-subtle">
        {t("app.license")}
      </div>
      <div className="text-[11px] text-fg-subtle">
        {t("app.licenseCommercial")}
      </div>
      <div className="mt-1 text-[11px] text-fg-subtle">
        {t("app.builtWith")}
      </div>

      <div className="mt-4 flex flex-col items-center gap-2">
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
          {t("app.madeBy")}
        </div>
        <div className="rounded-lg bg-white/95 px-6 py-4 shadow-sm ring-1 ring-border-subtle">
          <img
            src={brandLogo}
            alt={isRu ? "Проявление" : "Proyavlenie"}
            className="h-12 w-auto select-none"
            draggable={false}
          />
        </div>
        <div className="mt-2 flex flex-col items-center gap-0.5 text-[11px]">
          <a
            href="https://yavlenie.pro"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            yavlenie.pro
          </a>
          <a
            href="mailto:mail@yavlenie.pro"
            className="text-fg-muted hover:text-accent hover:underline"
          >
            mail@yavlenie.pro
          </a>
        </div>
      </div>
    </div>
  );
}
