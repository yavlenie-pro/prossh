/**
 * Tiny store for the sidebar active tab so other components
 * (e.g. SessionsSidebar) can programmatically switch it.
 */
import { create } from "zustand";

export type SidebarMode = "sessions" | "files";

interface SidebarState {
  mode: SidebarMode;
  setMode: (mode: SidebarMode) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  mode: "sessions",
  setMode: (mode) => set({ mode }),
}));
