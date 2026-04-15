/**
 * Typed wrappers around the Tauri IPC commands declared in
 * `src-tauri/src/commands/sync.rs`.
 *
 * The passphrase used to encrypt the payload on Drive is *independent*
 * from the ProSSH master password (vault backend) — the rationale is that
 * users may want to share sessions across machines that don't share the
 * vault password.
 */
import { invoke } from "@tauri-apps/api/core";

export interface SyncConfig {
  clientId: string;
  filename: string;
  enabled: boolean;
  /** True when a user-supplied client secret is stored. */
  hasClientSecret: boolean;
  /**
   * True when the build ships with default OAuth credentials. When true,
   * the user can click "Connect to Google Drive" without touching Cloud
   * Console — the Advanced credentials section is hidden by default.
   */
  hasEmbeddedCreds: boolean;
  /**
   * Auto-sync cadence in minutes (0 = disabled). The frontend renders this
   * as a select; backend treats every non-zero value as "spawn a loop that
   * ticks every N minutes".
   */
  autoSyncIntervalMin: number;
}

export interface SyncStatus {
  config: SyncConfig;
  /** True iff OAuth tokens are currently persisted. */
  connected: boolean;
  accountEmail: string | null;
  accountName: string | null;
  fileId: string | null;
  /** RFC3339 of the last successful push or pull. */
  lastSyncedAt: string | null;
  /**
   * True when the master passphrase is cached in the backend (set via the
   * setup dialog). Auto-sync only runs when this is true.
   */
  passphraseCached: boolean;
}

export interface ApplyStats {
  groups: number;
  sessions: number;
  portForwards: number;
  colorProfiles: number;
  scripts: number;
  secrets: number;
}

export const syncApi = {
  status: () => invoke<SyncStatus>("sync_status"),
  configGet: () => invoke<SyncConfig>("sync_config_get"),
  /**
   * Save config. Pass `clientSecret: null` to leave the existing value
   * alone; pass an empty string to clear it.
   */
  configSet: (args: {
    clientId: string;
    clientSecret: string | null;
    filename: string;
    enabled: boolean;
  }) => invoke<SyncStatus>("sync_config_set", args),

  oauthConnect: () => invoke<SyncStatus>("sync_oauth_connect"),
  oauthDisconnect: () => invoke<SyncStatus>("sync_oauth_disconnect"),

  push: (passphrase: string) =>
    invoke<SyncStatus>("sync_push", { passphrase }),
  pull: (passphrase: string) =>
    invoke<ApplyStats>("sync_pull", { passphrase }),

  /**
   * Export the local snapshot to an encrypted file at `path`. Simpler
   * alternative to Drive — no OAuth, user carries the file via any
   * transport (Dropbox, USB, email, ...).
   */
  exportFile: (passphrase: string, path: string) =>
    invoke<void>("sync_export_file", { passphrase, path }),
  /** Read an encrypted file from `path`, decrypt, and merge into local DB. */
  importFile: (passphrase: string, path: string) =>
    invoke<ApplyStats>("sync_import_file", { passphrase, path }),

  /**
   * Cache the master passphrase in the backend so the auto-sync loop can
   * encrypt without re-prompting. When `remember` is true, the passphrase
   * is also persisted to the OS keyring so it survives a process restart.
   */
  passphraseSet: (passphrase: string, remember: boolean) =>
    invoke<SyncStatus>("sync_passphrase_set", { passphrase, remember }),
  /** Wipe both the in-memory and persisted passphrase. */
  passphraseClear: () => invoke<SyncStatus>("sync_passphrase_clear"),

  /** Set the auto-sync cadence in minutes. `0` disables. */
  autoIntervalSet: (minutes: number) =>
    invoke<SyncStatus>("sync_auto_interval_set", { minutes }),

  /** Trigger one auto-sync cycle (pull → push) immediately. */
  autoRunNow: () => invoke<SyncStatus>("sync_auto_run_now"),
};
