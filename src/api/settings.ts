/**
 * Typed wrappers for settings & color profiles IPC commands.
 */
import { invoke } from "@tauri-apps/api/core";

import type { ColorProfile, ColorProfileInput } from "./types";

export const colorProfilesApi = {
  list: () => invoke<ColorProfile[]>("color_profiles_list"),
  upsert: (input: ColorProfileInput) =>
    invoke<ColorProfile>("color_profiles_upsert", { input }),
  remove: (id: string) => invoke<void>("color_profiles_delete", { id }),
};

export const settingsApi = {
  get: (key: string) => invoke<string | null>("settings_get", { key }),
  set: (key: string, value: string) =>
    invoke<void>("settings_set", { key, value }),
};
