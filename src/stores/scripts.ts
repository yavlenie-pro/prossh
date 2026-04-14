/**
 * Zustand store for user scripts (global + per-session).
 * Scripts are loaded from the DB and cached; the palette reads from here.
 */
import { create } from "zustand";

import type { Script, ScriptInput } from "@/api/scripts";
import { scriptsApi } from "@/api/scripts";

interface ScriptsState {
  /** All scripts currently loaded (global + active session). */
  scripts: Script[];
  /** The session id we last loaded for (null = global only). */
  loadedForSession: string | null;
  loading: boolean;

  /** Load global scripts + scripts for a specific session. */
  load: (sessionId?: string) => Promise<void>;
  /** Load only global scripts. */
  loadGlobal: () => Promise<void>;
  /** Create or update a script. */
  upsert: (input: ScriptInput) => Promise<Script>;
  /** Delete a script by id. */
  remove: (id: string) => Promise<void>;
}

export const useScriptsStore = create<ScriptsState>((set) => ({
  scripts: [],
  loadedForSession: null,
  loading: false,

  load: async (sessionId) => {
    set({ loading: true });
    try {
      const scripts = await scriptsApi.list(sessionId);
      set({ scripts, loadedForSession: sessionId ?? null, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  loadGlobal: async () => {
    set({ loading: true });
    try {
      const scripts = await scriptsApi.listGlobal();
      set({ scripts, loadedForSession: null, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  upsert: async (input) => {
    const script = await scriptsApi.upsert(input);
    set((s) => {
      const exists = s.scripts.some((sc) => sc.id === script.id);
      return {
        scripts: exists
          ? s.scripts.map((sc) => (sc.id === script.id ? script : sc))
          : [...s.scripts, script],
      };
    });
    return script;
  },

  remove: async (id) => {
    await scriptsApi.delete(id);
    set((s) => ({ scripts: s.scripts.filter((sc) => sc.id !== id) }));
  },
}));
