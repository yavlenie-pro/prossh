import { SftpExplorer } from "@/components/sftp/SftpExplorer";
import { TerminalView } from "@/components/terminal/TerminalView";
import { useSessionsStore } from "@/stores/sessions";
import type { PaneLeaf } from "@/stores/tabs";
import { useTabsStore } from "@/stores/tabs";

interface Props {
  leaf: PaneLeaf;
}

/**
 * Renders the content of a single pane leaf. Currently only terminals are
 * supported; SFTP explorer lands in step 14.
 */
export function PaneLeafView({ leaf }: Props) {
  const focusPane = useTabsStore((s) => s.focusPane);
  const focusedPaneId = useTabsStore((s) => s.focusedPaneId);
  const session = useSessionsStore((s) =>
    s.sessions.find((sess) => sess.id === leaf.sessionId),
  );

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-fg-muted">
        Session not found
      </div>
    );
  }

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onFocusCapture={() => focusPane(leaf.id)}
      onClick={() => focusPane(leaf.id)}
    >
      {/* Subtle border highlight on the focused pane */}
      {focusedPaneId === leaf.id && (
        <div className="pointer-events-none absolute inset-0 z-20 rounded-sm border border-accent/30" />
      )}
      {leaf.kind === "terminal" ? (
        <TerminalView session={session} paneId={leaf.id} />
      ) : leaf.kind === "sftp" ? (
        <SftpExplorer session={session} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-fg-muted">
          Unknown pane kind
        </div>
      )}
    </div>
  );
}
