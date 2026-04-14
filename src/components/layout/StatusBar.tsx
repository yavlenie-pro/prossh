import { useState } from "react";
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useAppVersion } from "@/hooks/useAppVersion";
import { useSessionsStore } from "@/stores/sessions";
import { SystemWidgets } from "./SystemWidgets";

/**
 * Bottom status bar — session counter on the left, system monitoring widgets
 * in the centre, gear + version on the right.
 */
export function StatusBar() {
  const { t } = useTranslation();
  const sessionCount = useSessionsStore((s) => s.sessions.length);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const version = useAppVersion();

  return (
    <>
      <div className="flex h-7 items-center gap-3 border-t border-border-subtle bg-bg-elevated px-3 text-[11px] text-fg-muted">
        {/* Left — session counter */}
        <span className="shrink-0">
          {sessionCount === 0
            ? t("status.noSessions")
            : t("status.sessions", { count: sessionCount })}
        </span>

        <span className="flex-1" />

        {/* Centre — system widgets */}
        <SystemWidgets />

        <span className="flex-1" />

        {/* Right — settings + version */}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Open settings"
          className="inline-flex items-center gap-1 rounded px-1 text-fg-muted transition-colors hover:text-fg"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        <span className="shrink-0 font-mono" title={version ?? ""}>
          {version ? `v${version}` : ""}
        </span>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
