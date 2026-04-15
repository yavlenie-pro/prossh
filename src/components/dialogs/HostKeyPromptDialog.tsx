import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ShieldQuestion, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ptyApi } from "@/api/pty";
import { Button } from "@/components/ui/Button";
import { DraggableDialogContent } from "@/components/ui/DraggableDialogContent";

interface Props {
  promptId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  onDone: () => void;
}

/**
 * Modal dialog shown when the remote server's host key is not yet trusted.
 * The user can accept (trust-on-first-use) or reject the connection.
 */
export function HostKeyPromptDialog({
  promptId,
  host,
  port,
  algorithm,
  fingerprint,
  onDone,
}: Props) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);

  const respond = async (accept: boolean) => {
    console.log("[HostKeyPrompt] respond called:", { accept, promptId, submitting });
    if (submitting) return;
    setSubmitting(true);
    try {
      await ptyApi.resolveHostKey(promptId, accept);
    } catch (e) {
      console.error("resolveHostKey failed:", e);
    } finally {
      onDone();
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) void respond(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DraggableDialogContent className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-bg-elevated p-6 shadow-xl">
          <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-fg">
            <ShieldQuestion className="h-5 w-5 text-warning" />
            {t("hostKey.title")}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-fg-muted">
            {t("hostKey.description", { host, port })}
          </Dialog.Description>

          <div className="mt-4 space-y-2 rounded-lg border border-border-subtle bg-bg-overlay/50 px-4 py-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-subtle">{t("hostKey.algorithm")}</span>
              <span className="font-mono text-fg">{algorithm}</span>
            </div>
            <div className="flex items-start justify-between gap-4 text-xs">
              <span className="shrink-0 text-fg-subtle">{t("hostKey.fingerprint")}</span>
              <span className="break-all text-right font-mono text-fg">
                {fingerprint}
              </span>
            </div>
          </div>

          <p className="mt-3 text-xs text-fg-subtle">
            {t("hostKey.trustNote")}
          </p>

          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void respond(false)}
              disabled={submitting}
            >
              {t("hostKey.reject")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void respond(true)}
              disabled={submitting}
            >
              {t("hostKey.accept")}
            </Button>
          </div>

          <Dialog.Close asChild>
            <button
              type="button"
              className="absolute right-4 top-4 text-fg-subtle hover:text-fg"
              aria-label={t("titlebar.close")}
              onClick={() => void respond(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </DraggableDialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
