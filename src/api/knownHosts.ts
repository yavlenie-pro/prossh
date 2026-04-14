/**
 * Typed wrappers for the known-hosts store. The backend only exposes read &
 * revoke operations — additions happen during SSH connect (step 5+).
 */
import { invoke } from "@tauri-apps/api/core";

export interface KnownHostEntry {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  comment: string | null;
  addedAt: string;
}

export const knownHostsApi = {
  list: () => invoke<KnownHostEntry[]>("known_hosts_list"),
  remove: (host: string, port: number, algorithm: string) =>
    invoke<boolean>("known_hosts_remove", { host, port, algorithm }),
  clearHost: (host: string, port: number) =>
    invoke<number>("known_hosts_clear_host", { host, port }),
};
