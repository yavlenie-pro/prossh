import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, Cloud, FileKey, KeyRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { DraggableDialogContent } from "@/components/ui/DraggableDialogContent";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";

export type SyncPassphraseMode =
  | "push"
  | "pull"
  | "exportFile"
  | "importFile"
  /** Right after OAuth connect — set the master passphrase for auto-sync. */
  | "setup";

export interface SyncPassphraseOptions {
  /**
   * Only meaningful for `setup`: persist the passphrase to the OS keyring
   * so auto-sync survives a restart. Ignored for the other modes.
   */
  remember?: boolean;
}

interface Props {
  open: boolean;
  mode: SyncPassphraseMode;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the entered passphrase. Must return a promise that resolves
   * when the push/pull/export/import completes; the dialog stays open (with
   * a spinner state) until the promise settles.
   */
  onSubmit: (passphrase: string, options: SyncPassphraseOptions) => Promise<void>;
}

/**
 * Asks the user for the sync passphrase before pushing or pulling.
 *
 * Distinct from [`VaultPasswordDialog`]: the sync passphrase is what
 * encrypts the Drive payload; the vault password (when using the file
 * backend) is what unlocks local secrets. Users may pick different values
 * on purpose — e.g. to share sessions across devices that don't share the
 * same vault password.
 *
 * `push` also asks for confirmation (entered twice) so a typo doesn't
 * silently stash an unrecoverable ciphertext on Drive. `pull` only needs
 * one entry — if it's wrong, decryption fails loudly.
 */
export function SyncPassphraseDialog({ open, mode, onOpenChange, onSubmit }: Props) {
  const { t } = useTranslation();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  // Default ON: the whole point of setup is to enable auto-sync without
  // re-prompting on every restart. Users who don't want persistence can
  // uncheck.
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPass("");
    setConfirm("");
    setRemember(true);
    setError(null);
    setSubmitting(false);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  // Confirmation matters when we're ABOUT TO encrypt — a typo there yields
  // an unrecoverable ciphertext. Decrypt flows (pull, importFile) only need
  // one entry — if it's wrong, decryption fails loudly. Setup is encrypt-
  // adjacent (the cached passphrase will encrypt the first auto-sync push)
  // so we confirm there too.
  const needConfirm = mode === "push" || mode === "exportFile" || mode === "setup";
  const showRemember = mode === "setup";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!pass) {
      setError(t("sync.errorEmpty"));
      return;
    }
    if (needConfirm && pass !== confirm) {
      setError(t("sync.errorMismatch"));
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(pass, { remember: showRemember ? remember : undefined });
      reset();
      onOpenChange(false);
    } catch (err) {
      const msg =
        (err as { message?: string })?.message ??
        (typeof err === "string" ? err : JSON.stringify(err));
      setError(msg);
      setSubmitting(false);
    }
  };

  const titleKey = {
    push: "sync.dialogPushTitle",
    pull: "sync.dialogPullTitle",
    exportFile: "sync.dialogExportTitle",
    importFile: "sync.dialogImportTitle",
    setup: "sync.dialogSetupTitle",
  }[mode];
  const descKey = {
    push: "sync.dialogPushDesc",
    pull: "sync.dialogPullDesc",
    exportFile: "sync.dialogExportDesc",
    importFile: "sync.dialogImportDesc",
    setup: "sync.dialogSetupDesc",
  }[mode];
  const submitKey = {
    push: "sync.actionPush",
    pull: "sync.actionPull",
    exportFile: "sync.actionExportFile",
    importFile: "sync.actionImportFile",
    setup: "sync.actionSetup",
  }[mode];

  const showWarn = mode === "push" || mode === "exportFile" || mode === "setup";

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <DraggableDialogContent className="fixed left-1/2 top-1/2 z-[60] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-bg-elevated p-6 shadow-xl">
          <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg">
            {mode === "exportFile" || mode === "importFile" ? (
              <FileKey className="h-5 w-5 text-accent" />
            ) : mode === "setup" ? (
              <KeyRound className="h-5 w-5 text-accent" />
            ) : (
              <Cloud className="h-5 w-5 text-accent" />
            )}
            {t(titleKey)}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-xs text-fg-muted">
            {t(descKey)}
          </Dialog.Description>

          <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
            <div>
              <Label htmlFor="sync-pass">{t("sync.passphrase")}</Label>
              <Input
                id="sync-pass"
                type="password"
                autoFocus
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                disabled={submitting}
                autoComplete={mode === "push" ? "new-password" : "current-password"}
              />
            </div>
            {needConfirm && (
              <div>
                <Label htmlFor="sync-confirm">{t("sync.confirmPassphrase")}</Label>
                <Input
                  id="sync-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={submitting}
                  autoComplete="new-password"
                />
              </div>
            )}

            {showRemember && (
              <label className="flex items-start gap-2 text-[11px] text-fg-muted">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  disabled={submitting}
                />
                <span>
                  <span className="text-fg">{t("sync.rememberLabel")}</span>
                  <span className="ml-1">{t("sync.rememberHint")}</span>
                </span>
              </label>
            )}

            {showWarn && (
              <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("sync.warnPassphrase")}</span>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={close}
                disabled={submitting}
              >
                {t("dialog.cancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={submitting || !pass || (needConfirm && !confirm)}
              >
                {submitting ? t("sync.working") : t(submitKey)}
              </Button>
            </div>
          </form>

          <Dialog.Close asChild>
            <button
              type="button"
              className="absolute right-4 top-4 text-fg-subtle hover:text-fg"
              aria-label={t("titlebar.close")}
              onClick={close}
            >
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </DraggableDialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
