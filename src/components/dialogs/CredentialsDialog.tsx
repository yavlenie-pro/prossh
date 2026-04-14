import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { KeyRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ptyApi } from "@/api/pty";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";

interface Props {
  promptId: string;
  username: string;
  reason: string;
  onDone: () => void;
}

/**
 * Modal dialog asking the user for SSH credentials (username + password).
 * Shown when no password is stored, username is missing, or key auth was
 * rejected and we fall back to password.
 */
export function CredentialsDialog({ promptId, username, reason, onDone }: Props) {
  const { t } = useTranslation();
  const [user, setUser] = useState(username);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    await ptyApi.resolveCredentials(promptId, user, password);
    onDone();
  };

  const cancel = async () => {
    setSubmitting(true);
    await ptyApi.resolveCredentials(promptId, "", "");
    onDone();
  };

  const reasonKey =
    reason === "key_rejected"
      ? "credentials.reasonKeyRejected"
      : reason === "no_username"
        ? "credentials.reasonNoUsername"
        : "credentials.reasonNoPassword";

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) void cancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-bg-elevated p-6 shadow-xl">
          <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg">
            <KeyRound className="h-5 w-5 text-accent" />
            {t("credentials.title")}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-xs text-fg-muted">
            {t(reasonKey)}
          </Dialog.Description>

          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div>
              <Label htmlFor="cred-username">{t("credentials.username")}</Label>
              <Input
                id="cred-username"
                autoFocus={!username}
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder={t("credentials.usernamePlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="cred-password">{t("credentials.password")}</Label>
              <Input
                id="cred-password"
                type="password"
                autoFocus={!!username}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("credentials.passwordPlaceholder")}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void cancel()}
                disabled={submitting}
              >
                {t("dialog.cancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={submitting || !user || !password}
              >
                {t("credentials.connect")}
              </Button>
            </div>
          </form>

          <Dialog.Close asChild>
            <button
              type="button"
              className="absolute right-4 top-4 text-fg-subtle hover:text-fg"
              aria-label={t("titlebar.close")}
              onClick={() => void cancel()}
            >
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
