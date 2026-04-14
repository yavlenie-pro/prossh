/**
 * Typed wrappers around the Tauri IPC commands declared in
 * `src-tauri/src/commands/ssh.rs`.
 *
 * Step 5 only exposes `testConnect` — a synchronous probe that connects to
 * the server, runs a single command (`whoami` by default) and returns the
 * captured output. Later milestones add `openSession` / `writeToPty` /
 * `resizePty` / `closeSession` for the persistent terminal.
 */
import { invoke } from "@tauri-apps/api/core";

import type { SshTestResult } from "./types";

export const sshApi = {
  /**
   * Probe the session identified by `sessionId`. Fetches the stored password
   * from the OS keychain inside Rust — no secret ever reaches the JS side.
   */
  testConnect: (sessionId: string, command?: string) =>
    invoke<SshTestResult>("ssh_test_connect", {
      sessionId,
      command: command ?? null,
    }),

  /**
   * Best-effort detection of the remote OS family for an open PTY session.
   * Runs `uname -s` / `cat /etc/os-release` (or `ver` on Windows OpenSSH) on
   * the existing SSH transport, persists the result on the session row and
   * returns the token — or `null` if detection failed.
   */
  detectOs: (runtimeId: string, sessionId: string) =>
    invoke<string | null>("ssh_detect_os", { runtimeId, sessionId }),
};
