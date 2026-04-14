import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  PlayCircle,
  ShieldCheck,
  ShieldPlus,
  TerminalSquare,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { sshApi } from "@/api/ssh";
import type { Session, SshTestResult } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { formatError } from "@/stores/sessions";

interface Props {
  session: Session;
  onConnect?: () => void;
  onSftp?: () => void;
}

/**
 * Right-hand detail pane shown when a session is selected in the sidebar.
 *
 * Step 5 surfaces a "Test connect" button that runs `ssh_test_connect`
 * against the server and displays the captured stdout, exit code and host
 * key outcome. The full PTY terminal takes over this pane in step 6.
 */
export function SessionDetails({ session, onConnect, onSftp }: Props) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SshTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset test output whenever the user clicks a different session — stale
  // results from the previous server would be confusing.
  useEffect(() => {
    setResult(null);
    setError(null);
    setRunning(false);
  }, [session.id]);

  const handleTest = async () => {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const r = await sshApi.testConnect(session.id);
      setResult(r);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setRunning(false);
    }
  };

  const canTest = session.authMethod === "password";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="border-b border-border-subtle px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-mono text-xl text-fg">
              {session.name}
            </h1>
            <div className="mt-1 truncate text-sm text-fg-muted">
              {session.username}@{session.host}
              {session.port !== 22 ? `:${session.port}` : ""}
            </div>
            {session.description && (
              <p className="mt-3 max-w-2xl text-xs text-fg-subtle">
                {session.description}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {onConnect && (
              <Button
                size="sm"
                variant="primary"
                onClick={onConnect}
              >
                <TerminalSquare className="h-3.5 w-3.5" /> {t("session.connect")}
              </Button>
            )}
            {onSftp && (
              <Button
                size="sm"
                variant="secondary"
                onClick={onSftp}
              >
                <FolderOpen className="h-3.5 w-3.5" /> {t("session.sftp")}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void handleTest()}
              disabled={running || !canTest}
              title={
                canTest
                  ? "Run a one-shot connect + whoami to verify credentials"
                  : "Key / agent auth is not yet wired into the Test button"
              }
            >
              {running ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("session.testing")}
                </>
              ) : (
                <>
                  <PlayCircle className="h-3.5 w-3.5" /> {t("session.test")}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 px-6 py-5">
        <dl className="grid max-w-2xl grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-xs">
          <Row label={t("session.host")}>
            <span className="font-mono text-fg">
              {session.host}:{session.port}
            </span>
          </Row>
          <Row label={t("session.user")}>
            <span className="font-mono text-fg">{session.username}</span>
          </Row>
          <Row label={t("session.auth")}>
            <span className="font-mono capitalize text-fg">
              {session.authMethod}
              {session.authMethod === "key" && session.privateKeyPath && (
                <span className="text-fg-muted"> ({session.privateKeyPath})</span>
              )}
            </span>
          </Row>
          <Row label={t("session.storedSecret")}>
            <span className="font-mono text-fg-muted">
              {session.useKeychain ? t("session.enabled") : t("session.off")}
            </span>
          </Row>
          {session.lastUsedAt && (
            <Row label={t("session.lastUsed")}>
              <span className="text-fg-muted">
                {new Date(session.lastUsedAt).toLocaleString()}
              </span>
            </Row>
          )}
        </dl>

        {!canTest && (
          <div className="mt-6 max-w-2xl rounded border border-border-subtle bg-bg-overlay/40 px-4 py-3 text-xs text-fg-muted">
            {t("session.testOnlyPassword")}
          </div>
        )}

        {error && (
          <div className="mt-6 max-w-2xl rounded border border-danger/30 bg-danger/10 px-4 py-3 text-xs text-danger">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" /> {t("session.connectFailed")}
            </div>
            <div className="whitespace-pre-wrap font-mono text-[11px]">
              {error}
            </div>
          </div>
        )}

        {result && <TestResultCard result={result} />}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function TestResultCard({ result }: { result: SshTestResult }) {
  const { t } = useTranslation();
  const ok = (result.exitCode ?? 0) === 0;
  return (
    <div className="mt-6 max-w-2xl rounded border border-border-subtle bg-bg-overlay/40">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-2">
        <div className="flex items-center gap-2 text-xs">
          {ok ? (
            <CheckCircle2 className="h-4 w-4 text-accent" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-warning" />
          )}
          <span className="font-medium text-fg">
            {ok ? t("session.connectSucceeded") : t("session.commandNonZero")}
          </span>
          <span className="text-fg-subtle">· {result.elapsedMs} ms</span>
        </div>
        <span className="font-mono text-[10px] text-fg-muted">
          exit={result.exitCode ?? "?"}
        </span>
      </div>

      <HostKeyBlock hostKey={result.hostKey} />

      {result.stdout && (
        <section className="border-t border-border-subtle px-4 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-subtle">
            stdout
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-fg">
            {result.stdout}
          </pre>
        </section>
      )}

      {result.stderr && (
        <section className="border-t border-border-subtle px-4 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-subtle">
            stderr
          </div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-warning">
            {result.stderr}
          </pre>
        </section>
      )}
    </div>
  );
}

function HostKeyBlock({ hostKey }: { hostKey: SshTestResult["hostKey"] }) {
  const { t } = useTranslation();
  let icon: React.ReactNode;
  let label: string;
  let tone = "text-fg-muted";
  switch (hostKey.status.kind) {
    case "trusted":
      icon = <ShieldCheck className="h-3.5 w-3.5 text-accent" />;
      label = t("session.hostKeyTrusted");
      tone = "text-fg";
      break;
    case "newlyAdded":
      icon = <ShieldPlus className="h-3.5 w-3.5 text-warning" />;
      label = t("session.hostKeyTofu");
      tone = "text-warning";
      break;
    case "mismatch":
      icon = <AlertTriangle className="h-3.5 w-3.5 text-danger" />;
      label = t("session.hostKeyMismatch");
      tone = "text-danger";
      break;
  }

  return (
    <section className="border-t border-border-subtle px-4 py-2 text-[11px]">
      <div className={`mb-1 flex items-center gap-1.5 ${tone}`}>
        {icon}
        {label}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-fg-muted">
        <span>{hostKey.algorithm}</span>
        <span className="text-fg">{hostKey.fingerprint}</span>
      </div>
      {hostKey.status.kind === "mismatch" && (
        <div className="mt-1 text-fg-muted">
          {t("session.previouslyTrusted")}: <span className="font-mono text-fg">{hostKey.status.stored}</span>
        </div>
      )}
    </section>
  );
}
