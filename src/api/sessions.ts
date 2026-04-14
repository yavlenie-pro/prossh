/**
 * Typed wrappers around the Tauri IPC commands declared in
 * `src-tauri/src/commands/sessions.rs`.
 */
import { invoke } from "@tauri-apps/api/core";

import type { Group, GroupInput, PortForward, PortForwardInput, Session, SessionInput, SshConfigEntry } from "./types";

export const sessionsApi = {
  list: () => invoke<Session[]>("sessions_list"),
  upsert: (input: SessionInput) => invoke<Session>("sessions_upsert", { input }),
  remove: (id: string) => invoke<void>("sessions_delete", { id }),
  /** Remove duplicate sessions (same host+port+username), keep oldest. */
  dedup: () => invoke<number>("sessions_dedup"),
};

export interface PuttySession {
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath: string | null;
  protocol: string;
}

export interface MobaSession {
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath: string | null;
  /** Group/folder path from bookmarks (e.g. "AEZA/STAGE") */
  group: string | null;
}

export const configApi = {
  /** Parse ~/.ssh/config (or a custom path) and return discovered Host entries. */
  importSshConfig: (path?: string) =>
    invoke<SshConfigEntry[]>("import_ssh_config", { path: path ?? null }),
};

export const puttyApi = {
  importSessions: () => invoke<PuttySession[]>("import_putty_sessions"),
};

export const mobaApi = {
  /** Read MobaXTerm sessions from Windows Registry. */
  importSessions: () => invoke<MobaSession[]>("import_moba_sessions"),
  /** Parse a .mxtsessions export file. */
  importFromFile: (path: string) => invoke<MobaSession[]>("import_moba_file", { path }),
};

export const groupsApi = {
  list: () => invoke<Group[]>("groups_list"),
  upsert: (input: GroupInput) => invoke<Group>("groups_upsert", { input }),
  remove: (id: string) => invoke<void>("groups_delete", { id }),
};

export const portForwardsApi = {
  list: (sessionId: string) => invoke<PortForward[]>("port_forwards_list", { sessionId }),
  upsert: (input: PortForwardInput) => invoke<PortForward>("port_forwards_upsert", { input }),
  remove: (id: string) => invoke<void>("port_forwards_delete", { id }),
};
