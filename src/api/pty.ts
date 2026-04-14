/**
 * Typed wrappers for the PTY lifecycle commands.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

export interface PtyChunk {
  data: number[];
}

export type SshStatus =
  | { kind: "connected"; runtimeId: string }
  | { kind: "disconnected"; runtimeId: string; reason: string }
  | { kind: "authenticating" }
  | { kind: "passphraseNeeded"; promptId: string; keyPath: string }
  | {
      kind: "hostKeyPrompt";
      promptId: string;
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
    }
  | {
      kind: "credentialsNeeded";
      promptId: string;
      username: string;
      reason: string;
    };

export const ptyApi = {
  openSession: (
    sessionId: string,
    cols: number,
    rows: number,
    onOutput: Channel<PtyChunk>,
    onStatus: Channel<SshStatus>,
  ) =>
    invoke<string>("open_session", {
      sessionId,
      cols,
      rows,
      onOutput,
      onStatus,
    }),

  writeToPty: (runtimeId: string, data: number[]) =>
    invoke<void>("write_to_pty", { runtimeId, data }),

  resizePty: (runtimeId: string, cols: number, rows: number) =>
    invoke<void>("resize_pty", { runtimeId, cols, rows }),

  closeSession: (runtimeId: string) =>
    invoke<void>("close_session", { runtimeId }),

  /** Fire-and-forget via Tauri event (not invoke) to avoid IPC deadlock
   *  when open_session invoke is still pending. */
  resolvePassphrase: (promptId: string, passphrase: string) =>
    emit("resolve-passphrase", { prompt_id: promptId, passphrase }),

  resolveHostKey: (promptId: string, accept: boolean) => {
    console.log("[ptyApi] resolveHostKey called:", { promptId, accept });
    return emit("resolve-host-key", { prompt_id: promptId, accept });
  },

  resolveCredentials: (promptId: string, username: string, password: string) =>
    emit("resolve-credentials", { prompt_id: promptId, username, password }),
};
