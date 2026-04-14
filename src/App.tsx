import { useEffect } from "react";

import { AppShell } from "./components/layout/AppShell";
import { useThemeStore } from "./stores/theme";

export default function App() {
  const loadTheme = useThemeStore((s) => s.load);

  useEffect(() => {
    void loadTheme();
  }, [loadTheme]);

  return <AppShell />;
}
