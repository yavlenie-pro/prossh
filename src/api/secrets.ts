/**
 * Typed wrappers around the Tauri IPC commands declared in
 * `src-tauri/src/commands/secrets.rs`.
 *
 * Note: there is intentionally no `get` — raw secrets never leave the
 * backend. The UI can only check existence, write a new secret, or clear one.
 */
import { invoke } from "@tauri-apps/api/core";

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
};
