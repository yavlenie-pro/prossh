import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, Lock, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { DraggableDialogContent } from "@/components/ui/DraggableDialogContent";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";

export type VaultPasswordMode = "create" | "unlock" | "change";

interface Props {
  open: boolean;
  mode: VaultPasswordMode;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the entered password(s). For `create`/`unlock`, `oldPassword`
   * is empty. For `change`, both are set. Must resolve or reject — the
   * dialog keeps the form enabled while the promise is pending.
   */
  onSubmit: (newPassword: string, oldPassword: string) => Promise<void>;
}

/**
 * Unified dialog for the three password flows of the encrypted vault:
 *
 * - `create` — pick a brand-new master password (confirmed twice).
 * - `unlock` — supply the existing master password to decrypt the vault.
 * - `change` — supply both the current and a new master password.
 */
export function VaultPasswordDialog({ open, mode, onOpenChange, onSubmit }: Props) {
  const { t } = useTranslation();
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setOldPw("");
    setNewPw("");
    setConfirmPw("");
    setError(null);
    setSubmitting(false);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const needConfirm = mode !== "unlock";
  const needOld = mode === "change";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === "unlock") {
      if (!newPw) return;
    } else {
      if (!newPw) {
        setError(t("vault.errorEmpty"));
        return;
      }
      if (newPw !== confirmPw) {
        setError(t("vault.errorMismatch"));
        return;
      }
      if (needOld && !oldPw) {
        setError(t("vault.errorNoOld"));
        return;
      }
    }

    setSubmitting(true);
    try {
      await onSubmit(newPw, oldPw);
      reset();
      onOpenChange(false);
    } catch (err) {
      // The backend returns AppError as `{ kind, message }` — pull message
      // if it's in that shape, otherwise stringify.
      const msg =
        (err as { message?: string })?.message ??
        (typeof err === "string" ? err : JSON.stringify(err));
      setError(msg);
      setSubmitting(false);
    }
  };

  const titleKey =
    mode === "create"
      ? "vault.titleCreate"
      : mode === "change"
      ? "vault.titleChange"
      : "vault.titleUnlock";
  const descKey =
    mode === "create"
      ? "vault.descCreate"
      : mode === "change"
      ? "vault.descChange"
      : "vault.descUnlock";
  const submitKey =
    mode === "create"
      ? "vault.submitCreate"
      : mode === "change"
      ? "vault.submitChange"
      : "vault.submitUnlock";

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
            <Lock className="h-5 w-5 text-accent" />
            {t(titleKey)}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-xs text-fg-muted">
            {t(descKey)}
          </Dialog.Description>

          <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
            {needOld && (
              <div>
                <Label htmlFor="vault-old">{t("vault.currentPassword")}</Label>
                <Input
                  id="vault-old"
                  type="password"
                  autoFocus
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                  disabled={submitting}
                  autoComplete="current-password"
                />
              </div>
            )}
            <div>
              <Label htmlFor="vault-new">
                {mode === "unlock"
                  ? t("vault.masterPassword")
                  : t("vault.newPassword")}
              </Label>
              <Input
                id="vault-new"
                type="password"
                autoFocus={!needOld}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                disabled={submitting}
                autoComplete={mode === "unlock" ? "current-password" : "new-password"}
              />
            </div>
            {needConfirm && (
              <div>
                <Label htmlFor="vault-confirm">{t("vault.confirmPassword")}</Label>
                <Input
                  id="vault-confirm"
                  type="password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  disabled={submitting}
                  autoComplete="new-password"
                />
              </div>
            )}

            {mode === "create" && (
              <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("vault.warnLoss")}</span>
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
                disabled={submitting || !newPw || (needConfirm && !confirmPw) || (needOld && !oldPw)}
              >
                {t(submitKey)}
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
