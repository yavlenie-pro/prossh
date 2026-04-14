/**
 * Zustand store for the known-hosts panel. Kept separate from the sessions
 * store because the two datasets are edited from different places.
 */
import { create } from "zustand";

import { knownHostsApi, type KnownHostEntry } from "@/api/knownHosts";

import { formatError } from "./sessions";

interface State {
  entries: KnownHostEntry[];
  loading: boolean;
  error: string | null;
}

interface Actions {
  load: () => Promise<void>;
  remove: (host: string, port: number, algorithm: string) => Promise<void>;
  clearHost: (host: string, port: number) => Promise<void>;
  clearError: () => void;
}

export const useKnownHostsStore = create<State & Actions>((set) => ({
  entries: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const entries = await knownHostsApi.list();
      set({ entries: sortEntries(entries), loading: false });
    } catch (e) {
      set({ loading: false, error: formatError(e) });
    }
  },

  remove: async (host, port, algorithm) => {
    await knownHostsApi.remove(host, port, algorithm);
    set((s) => ({
      entries: s.entries.filter(
        (e) => !(e.host === host && e.port === port && e.algorithm === algorithm),
      ),
    }));
  },

  clearHost: async (host, port) => {
    await knownHostsApi.clearHost(host, port);
    set((s) => ({
      entries: s.entries.filter((e) => !(e.host === host && e.port === port)),
    }));
  },

  clearError: () => set({ error: null }),
}));

function sortEntries(entries: KnownHostEntry[]): KnownHostEntry[] {
  return [...entries].sort((a, b) => {
    const hostCmp = a.host.localeCompare(b.host, undefined, { sensitivity: "base" });
    if (hostCmp !== 0) return hostCmp;
    if (a.port !== b.port) return a.port - b.port;
    return a.algorithm.localeCompare(b.algorithm);
  });
}
