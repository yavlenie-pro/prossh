/**
 * Typed wrappers around the Tauri IPC commands declared in
 * `src-tauri/src/commands/secrets.rs`.
 *
 * Note: there is intentionally no `get` — raw secrets never leave the
 * backend. The UI can only check existence, write a new secret, or clear one.
 */
import { invoke } from "@tauri-apps/api/core";

export type SecretBackendKind = "auto" | "keyring" | "file";

export interface BackendStatus {
  /** What the user picked in settings — may be "auto". */
  configured: SecretBackendKind;
  /** What's actually in use — never "auto" after resolution. */
  effective: Exclude<SecretBackendKind, "auto">;
  /** Whether the OS keyring responded to a probe at startup / refresh. */
  keyringAvailable: boolean;
  /** Whether the encrypted file vault exists on disk. */
  fileExists: boolean;
  /** Whether the encrypted file vault is currently unlocked in-process. */
  fileUnlocked: boolean;
}

export const secretsApi = {
  set: (sessionId: string, secret: string) =>
    invoke<void>("secrets_set", { sessionId, secret }),
  has: (sessionId: string) =>
    invoke<boolean>("secrets_has", { sessionId }),
  clear: (sessionId: string) =>
    invoke<void>("secrets_clear", { sessionId }),
  /** Copy the stored secret from one session to another. */
  copy: (fromSessionId: string, toSessionId: string) =>
    invoke<void>("secrets_copy", { fromSessionId, toSessionId }),

  // ---- backend selection / vault management ----

  backendStatus: () => invoke<BackendStatus>("secrets_backend_status"),
  setBackend: (kind: SecretBackendKind) =>
    invoke<BackendStatus>("secrets_set_backend", { kind }),
  vaultCreate: (password: string) =>
    invoke<BackendStatus>("secrets_vault_create", { password }),
  vaultUnlock: (password: string) =>
    invoke<BackendStatus>("secrets_vault_unlock", { password }),
  vaultLock: () => invoke<BackendStatus>("secrets_vault_lock"),
  vaultChangePassword: (oldPassword: string, newPassword: string) =>
    invoke<BackendStatus>("secrets_vault_change_password", {
      oldPassword,
      newPassword,
    }),
  vaultDestroy: () => invoke<BackendStatus>("secrets_vault_destroy"),
};
