/**
 * Zustand store for terminal theming — manages color profiles and the
 * currently selected profile.
 */
import { create } from "zustand";

import { colorProfilesApi, settingsApi } from "@/api/settings";
import type { ColorProfile } from "@/api/types";
import type { ITheme } from "@xterm/xterm";

const SETTINGS_KEY = "terminal.colorProfileId";
const DEFAULT_PROFILE_ID = "tokyo-night";

interface ThemeState {
  profiles: ColorProfile[];
  activeProfileId: string;
  loading: boolean;
}

interface ThemeActions {
  load: () => Promise<void>;
  setActive: (id: string) => Promise<void>;
  /** Build an xterm ITheme from the currently active profile. */
  xtermTheme: () => ITheme;
  activeProfile: () => ColorProfile | undefined;
}

export const useThemeStore = create<ThemeState & ThemeActions>((set, get) => ({
  profiles: [],
  activeProfileId: DEFAULT_PROFILE_ID,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const [profiles, savedId] = await Promise.all([
        colorProfilesApi.list(),
        settingsApi.get(SETTINGS_KEY),
      ]);
      set({
        profiles,
        activeProfileId: savedId ?? DEFAULT_PROFILE_ID,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  setActive: async (id: string) => {
    set({ activeProfileId: id });
    await settingsApi.set(SETTINGS_KEY, id);
  },

  activeProfile: () => {
    const { profiles, activeProfileId } = get();
    return (
      profiles.find((p) => p.id === activeProfileId) ?? profiles[0]
    );
  },

  xtermTheme: () => {
    const profile = get().activeProfile();
    if (!profile) {
      // Fallback to Tokyo Night defaults
      return {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
      };
    }
    return profileToXterm(profile);
  },
}));

function profileToXterm(p: ColorProfile): ITheme {
  return {
    foreground: p.foreground,
    background: p.background,
    cursor: p.cursor,
    selectionBackground: p.selection,
    black: p.black,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.magenta,
    cyan: p.cyan,
    white: p.white,
    brightBlack: p.brightBlack,
    brightRed: p.brightRed,
    brightGreen: p.brightGreen,
    brightYellow: p.brightYellow,
    brightBlue: p.brightBlue,
    brightMagenta: p.brightMagenta,
    brightCyan: p.brightCyan,
    brightWhite: p.brightWhite,
  };
}
