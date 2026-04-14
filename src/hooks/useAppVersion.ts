import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Returns the display version string baked into the Rust binary at build time.
 *
 * The value comes from the `app_version` IPC command, which reads the
 * `PROSSH_VERSION` constant set by `src-tauri/build.rs`:
 *   - CI builds: `PROSSH_BUILD_VERSION` env var (e.g. `0.1.0` for a tagged
 *     release, `0.1.0-dev.42+sha.abc1234` for a main-branch CI build).
 *   - Local dev: `CARGO_PKG_VERSION` + `+sha.<shortSHA>` when inside a git
 *     checkout, just `CARGO_PKG_VERSION` otherwise.
 *
 * Returns `null` while the IPC call is in flight.
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("app_version")
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        // IPC failure is non-fatal — we just leave the UI showing nothing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
