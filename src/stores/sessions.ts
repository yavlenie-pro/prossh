/**
 * Zustand store for sessions & groups.
 *
 * The store talks to the Rust backend via `sessionsApi`/`groupsApi`. On every
 * mutation we apply an optimistic-ish local update — the backend is the source
 * of truth, so we always use the value it returned (which includes
 * server-side timestamps and ids).
 */
import { create } from "zustand";

import { groupsApi, sessionsApi } from "@/api/sessions";
import { secretsApi } from "@/api/secrets";
import type { AppError, Group, GroupInput, Session, SessionInput } from "@/api/types";

interface State {
  sessions: Session[];
  groups: Group[];
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;
}

interface Actions {
  load: () => Promise<void>;
  upsertSession: (input: SessionInput) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  duplicateSession: (session: Session) => Promise<Session>;
  /** Update the cached `osType` field locally after the Rust side detected
   *  and persisted it. No DB round-trip — we're mirroring what was already
   *  written on the backend. */
  patchOsType: (sessionId: string, osType: string | null) => void;
  upsertGroup: (input: GroupInput) => Promise<Group>;
  deleteGroup: (id: string) => Promise<void>;
  select: (id: string | null) => void;
  clearError: () => void;
}

export const useSessionsStore = create<State & Actions>((set) => ({
  sessions: [],
  groups: [],
  loading: false,
  error: null,
  selectedSessionId: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      // One-time dedup of legacy duplicates created by repeated imports
      await sessionsApi.dedup();
      const [sessions, groups] = await Promise.all([
        sessionsApi.list(),
        groupsApi.list(),
      ]);
      set({
        sessions: sortSessions(sessions),
        groups: sortGroups(groups),
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: formatError(e) });
    }
  },

  upsertSession: async (input) => {
    const saved = await sessionsApi.upsert(input);
    set((s) => {
      const idx = s.sessions.findIndex((x) => x.id === saved.id);
      const next =
        idx === -1
          ? [...s.sessions, saved]
          : s.sessions.map((x) => (x.id === saved.id ? saved : x));
      return { sessions: sortSessions(next) };
    });
    return saved;
  },

  deleteSession: async (id) => {
    await sessionsApi.remove(id);
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      selectedSessionId:
        s.selectedSessionId === id ? null : s.selectedSessionId,
    }));
  },

  duplicateSession: async (session) => {
    const input: SessionInput = {
      // No id → backend creates a new one
      groupId: session.groupId,
      name: `${session.name} (copy)`,
      host: session.host,
      port: session.port,
      username: session.username,
      authMethod: session.authMethod,
      privateKeyPath: session.privateKeyPath,
      useKeychain: session.useKeychain,
      description: session.description,
      color: session.color,
    };
    const saved = await sessionsApi.upsert(input);
    // Copy secret (password/passphrase) from original to duplicate
    if (session.useKeychain) {
      await secretsApi.copy(session.id, saved.id).catch(() => {});
    }
    set((s) => ({ sessions: sortSessions([...s.sessions, saved]) }));
    return saved;
  },

  patchOsType: (sessionId, osType) =>
    set((s) => {
      const idx = s.sessions.findIndex((x) => x.id === sessionId);
      if (idx === -1 || s.sessions[idx].osType === osType) return s;
      const next = [...s.sessions];
      next[idx] = { ...next[idx], osType };
      return { sessions: next };
    }),

  upsertGroup: async (input) => {
    const saved = await groupsApi.upsert(input);
    set((s) => {
      const idx = s.groups.findIndex((x) => x.id === saved.id);
      const next =
        idx === -1
          ? [...s.groups, saved]
          : s.groups.map((x) => (x.id === saved.id ? saved : x));
      return { groups: sortGroups(next) };
    });
    return saved;
  },

  deleteGroup: async (id) => {
    await groupsApi.remove(id);
    set((s) => ({ groups: s.groups.filter((x) => x.id !== id) }));
  },

  select: (id) => set({ selectedSessionId: id }),
  clearError: () => set({ error: null }),
}));

function sortSessions(items: Session[]): Session[] {
  return [...items].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

function sortGroups(items: Group[]): Group[] {
  return [...items].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** Extract a user-facing string from Tauri's serialised `AppError`. */
export function formatError(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as AppError).message);
  }
  return String(e);
}
