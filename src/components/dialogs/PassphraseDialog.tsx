import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { KeySquare, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ptyApi } from "@/api/pty";
import { Button } from "@/components/ui/Button";
import { DraggableDialogContent } from "@/components/ui/DraggableDialogContent";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";

interface Props {
  promptId: string;
  keyPath: string;
  onDone: () => void;
}

/**
 * Modal dialog asking the user for the passphrase to decrypt an SSH private key.
 * Shown when `SshStatus.passphraseNeeded` arrives during `open_session`.
 */
export function PassphraseDialog({ promptId, keyPath, onDone }: Props) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (value: string) => {
    setSubmitting(true);
    await ptyApi.resolvePassphrase(promptId, value);
    onDone();
  };

  const cancel = async () => {
    setSubmitting(true);
    await ptyApi.resolvePassphrase(promptId, "");
    onDone();
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) void cancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DraggableDialogContent className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-bg-elevated p-6 shadow-xl">
          <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg">
            <KeySquare className="h-5 w-5 text-accent" />
            {t("passphrase.title")}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-xs text-fg-muted">
            {t("passphrase.description")}
          </Dialog.Description>

          <div className="mt-3 rounded border border-border-subtle bg-bg-overlay/50 px-3 py-1.5 font-mono text-xs text-fg-muted">
            {keyPath}
          </div>

          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(passphrase);
            }}
          >
            <Label htmlFor="passphrase">{t("passphrase.label")}</Label>
            <Input
              id="passphrase"
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={t("passphrase.placeholder")}
            />

            <div className="mt-5 flex justify-end gap-2">
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
                disabled={submitting || !passphrase}
              >
                {t("passphrase.unlock")}
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
        </DraggableDialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
