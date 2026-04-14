/**
 * Typed wrappers for user scripts CRUD.
 *
 * A script with `sessionId: null` is global (visible for all sessions).
 * A script with a specific `sessionId` is per-session.
 */
import { invoke } from "@tauri-apps/api/core";

export interface Script {
  id: string;
  sessionId: string | null;
  name: string;
  command: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptInput {
  id?: string;
  sessionId: string | null;
  name: string;
  command: string;
  sortOrder?: number;
}

export const scriptsApi = {
  /** List global + session-specific scripts. */
  list: (sessionId?: string) =>
    invoke<Script[]>("scripts_list", { sessionId: sessionId ?? null }),

  /** List only global scripts. */
  listGlobal: () => invoke<Script[]>("scripts_list_global"),

  /** List scripts for a specific session only (no globals). */
  listForSession: (sessionId: string) =>
    invoke<Script[]>("scripts_list_for_session", { sessionId }),

  /** Create or update a script. */
  upsert: (input: ScriptInput) =>
    invoke<Script>("scripts_upsert", { input }),

  /** Delete a script by id. */
  delete: (id: string) => invoke<void>("scripts_delete", { id }),
};
