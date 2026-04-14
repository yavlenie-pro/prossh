/**
 * Shared types mirroring the Rust-side `sessions` module.
 *
 * Keep these in sync with `src-tauri/src/sessions/mod.rs`. Serde is configured
 * with `rename_all = "camelCase"` on `Group`, `Session`, `SessionInput` and
 * `GroupInput`, so field names match 1:1.
 */

export type AuthMethod = "password" | "key" | "agent";

export interface Group {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  groupId: string | null;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath: string | null;
  useKeychain: boolean;
  description: string | null;
  color: string | null;
  /** Remote OS family auto-detected on connect — `linux`, `ubuntu`, `debian`,
   *  `centos`, `fedora`, `arch`, `alpine`, `freebsd`, `macos`, `windows`. */
  osType: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInput {
  id?: string;
  groupId: string | null;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath: string | null;
  useKeychain: boolean;
  description: string | null;
  color: string | null;
}

export interface GroupInput {
  id?: string;
  name: string;
  parentId: string | null;
  sortOrder?: number;
}

// --- Port forwarding ----------------------------------------------------------

export type PortForwardType = "local" | "remote";

export interface PortForward {
  id: string;
  sessionId: string;
  forwardType: PortForwardType;
  label: string | null;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PortForwardInput {
  id?: string;
  sessionId: string;
  forwardType: PortForwardType;
  label?: string | null;
  bindHost?: string;
  bindPort: number;
  targetHost?: string;
  targetPort: number;
  enabled?: boolean;
}

/**
 * Shape of the backend's `AppError` after Tauri serialises it into the JS-side
 * rejection value. The `kind` field can be narrowed for specific branches.
 */
export interface AppError {
  kind:
    | "setup"
    | "io"
    | "serde"
    | "database"
    | "secret"
    | "ssh"
    | "not_found"
    | "invalid_argument"
    | "internal";
  message: string;
}

// --- Color profiles (step 11) ------------------------------------------------

export interface ColorProfile {
  id: string;
  name: string;
  isBuiltin: boolean;
  foreground: string;
  background: string;
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  createdAt: string;
  updatedAt: string;
}

export type ColorProfileInput = Omit<ColorProfile, "isBuiltin" | "createdAt" | "updatedAt"> & {
  id?: string;
};

// --- SSH config import (step 10) ---------------------------------------------

export interface SshConfigEntry {
  alias: string;
  host: string | null;
  port: number | null;
  user: string | null;
  identityFile: string | null;
}

// --- SSH test connect (step 5) -----------------------------------------------

export type HostKeyStatus =
  | { kind: "trusted" }
  | { kind: "newlyAdded" }
  | { kind: "mismatch"; stored: string };

export interface HostKeyReport {
  algorithm: string;
  fingerprint: string;
  status: HostKeyStatus;
}

export interface SshTestResult {
  hostKey: HostKeyReport;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}
