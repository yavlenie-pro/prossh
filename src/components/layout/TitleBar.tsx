import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { TabBar } from "@/components/tabs/TabBar";
import { AppLogo } from "@/components/ui/AppLogo";
import { cn } from "@/lib/cn";
import { useTabsStore } from "@/stores/tabs";

const appWindow = getCurrentWindow();

function ControlButton({
  onClick,
  className,
  children,
  ariaLabel,
}: {
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "titlebar-no-drag flex h-9 w-11 items-center justify-center text-fg-muted hover:bg-bg-elevated hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * Custom titlebar in Windows Terminal style: app logo on the left, session
 * tabs flowing in the middle (drag region fills any leftover space), and
 * window controls on the right. The whole bar is 36 px tall.
 */
export function TitleBar() {
  const { t } = useTranslation();
  const hasTabs = useTabsStore((s) => s.tabs.length > 0);

  return (
    <div
      data-tauri-drag-region
      className="titlebar-drag flex h-9 shrink-0 select-none items-stretch border-b border-border-subtle bg-bg"
    >
      {/* App identity */}
      <div
        data-tauri-drag-region
        className="titlebar-drag flex items-center gap-2 pl-3 pr-3"
      >
        <AppLogo size={16} className="pointer-events-none text-accent" />
        <span className="pointer-events-none font-mono text-xs text-fg-muted">
          {t("app.name")}
        </span>
      </div>

      {/* Tabs — fill the middle. When there are no tabs the remaining space
          stays as drag region so users can still move the window. */}
      {hasTabs ? (
        <TabBar />
      ) : (
        <div data-tauri-drag-region className="titlebar-drag flex-1" />
      )}

      {/* Window controls */}
      <div className="titlebar-no-drag flex shrink-0">
        <ControlButton ariaLabel={t("titlebar.minimize")} onClick={() => appWindow.minimize()}>
          <Minus size={14} />
        </ControlButton>
        <ControlButton ariaLabel={t("titlebar.maximize")} onClick={() => appWindow.toggleMaximize()}>
          <Square size={12} />
        </ControlButton>
        <ControlButton
          ariaLabel={t("titlebar.close")}
          onClick={() => appWindow.close()}
          className="hover:!bg-danger hover:!text-white"
        >
          <X size={14} />
        </ControlButton>
      </div>
    </div>
  );
}
