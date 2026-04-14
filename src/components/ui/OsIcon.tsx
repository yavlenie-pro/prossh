/**
 * OS-family icons for session tabs.
 *
 * We don't (yet) store an OS type on sessions. Instead we guess from the
 * session's name, host and description via {@link detectOsFromSession}:
 * if any of them contains a known token (`ubuntu`, `debian`, `centos`,
 * `arch`, `alpine`, `fedora`, `rhel`, `rocky`, `freebsd`, `macos`, `darwin`,
 * `windows`, `win`, generic `linux`) we pick that icon. Otherwise we fall
 * back to a generic terminal glyph.
 *
 * Icons are simple geometric SVGs drawn in currentColor — they inherit the
 * tab's text color and scale crisply at any size.
 */
import type { Session } from "@/api/types";

export type OsType =
  | "windows"
  | "macos"
  | "ubuntu"
  | "debian"
  | "fedora"
  | "centos"
  | "arch"
  | "alpine"
  | "freebsd"
  | "linux"
  | "unknown";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Order matters — more specific distros come before generic `linux`.
const OS_TOKENS: Array<{ os: OsType; tokens: string[] }> = [
  { os: "ubuntu", tokens: ["ubuntu"] },
  { os: "debian", tokens: ["debian"] },
  { os: "fedora", tokens: ["fedora"] },
  { os: "centos", tokens: ["centos", "rhel", "rocky", "almalinux", "redhat", "red-hat", "oracle-linux"] },
  { os: "arch", tokens: ["arch", "manjaro"] },
  { os: "alpine", tokens: ["alpine"] },
  { os: "freebsd", tokens: ["freebsd", "openbsd", "netbsd", "bsd"] },
  { os: "macos", tokens: ["macos", "darwin", "mac-os", "osx"] },
  { os: "windows", tokens: ["windows", "win-server", "winserver", "win10", "win11", "winsrv"] },
  { os: "linux", tokens: ["linux", "gentoo", "suse", "opensuse", "kali", "mint"] },
];

/** Lower-case a string once, then look for the first matching OS token. */
export function detectOs(haystack: string): OsType {
  const h = haystack.toLowerCase();
  for (const { os, tokens } of OS_TOKENS) {
    for (const token of tokens) {
      if (h.includes(token)) return os;
    }
  }
  return "unknown";
}

/** Convert the opaque token persisted on a session (set by the Rust
 *  `ssh_detect_os` command) into our {@link OsType} enum. Unknown strings
 *  fall through to `"unknown"`. */
function parseStoredOs(token: string | null | undefined): OsType {
  if (!token) return "unknown";
  switch (token.toLowerCase()) {
    case "windows":
    case "macos":
    case "ubuntu":
    case "debian":
    case "fedora":
    case "centos":
    case "arch":
    case "alpine":
    case "freebsd":
    case "linux":
      return token.toLowerCase() as OsType;
    default:
      return "unknown";
  }
}

/**
 * Resolve the OS for a session, preferring the value stored on the session
 * (auto-detected via `uname` on connect) and falling back to a name/host
 * heuristic for sessions that were never connected yet.
 */
export function detectOsFromSession(
  session: Pick<Session, "name" | "host" | "description" | "osType"> | undefined,
): OsType {
  if (!session) return "unknown";
  const stored = parseStoredOs(session.osType);
  if (stored !== "unknown") return stored;
  const haystack = [session.name, session.host, session.description ?? ""].join(" ");
  return detectOs(haystack);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface OsIconProps {
  os: OsType;
  size?: number;
  className?: string;
  title?: string;
}

/** Brand accent per OS — applied when the tab isn't active enough to rely on
 *  currentColor alone. Kept subtle so tabs stay readable. */
const OS_COLOR: Record<OsType, string> = {
  windows: "#0078D6",
  macos: "currentColor",
  ubuntu: "#E95420",
  debian: "#A80030",
  fedora: "#294172",
  centos: "#932279",
  arch: "#1793D1",
  alpine: "#0D597F",
  freebsd: "#AB2B28",
  linux: "#F2B200",
  unknown: "currentColor",
};

export function osColor(os: OsType): string {
  return OS_COLOR[os];
}

export function OsIcon({ os, size = 14, className, title }: OsIconProps) {
  const common = {
    xmlns: "http://www.w3.org/2000/svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    className,
    "aria-hidden": title ? undefined : true,
    role: title ? "img" : undefined,
  } as const;

  switch (os) {
    case "windows":
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path
            fill="currentColor"
            d="M3 5.5l8-1.1V11H3zM12 4.25L21 3v8H12zM3 12h8v6.6l-8-1.1zM12 12h9v9l-9-1.25z"
          />
        </svg>
      );
    case "macos":
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path
            fill="currentColor"
            d="M16.37 12.36c-.02-2.18 1.78-3.23 1.86-3.28-1.02-1.49-2.6-1.69-3.17-1.71-1.35-.14-2.63.79-3.32.79-.69 0-1.74-.77-2.86-.75-1.47.02-2.83.86-3.58 2.17-1.53 2.65-.39 6.57 1.09 8.72.73 1.05 1.59 2.23 2.72 2.19 1.09-.04 1.5-.7 2.81-.7 1.31 0 1.68.7 2.83.68 1.17-.02 1.9-1.07 2.61-2.13.82-1.22 1.16-2.4 1.18-2.46-.03-.01-2.25-.86-2.27-3.42zM14.21 5.9c.6-.73 1.01-1.74.9-2.75-.87.04-1.93.58-2.55 1.31-.56.64-1.05 1.66-.92 2.65.97.07 1.96-.49 2.57-1.21z"
          />
        </svg>
      );
    case "ubuntu":
      // Three circles ("Circle of Friends") — simplified.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="12" cy="4.5" r="1.8" fill="currentColor" />
          <circle cx="5.5" cy="15.75" r="1.8" fill="currentColor" />
          <circle cx="18.5" cy="15.75" r="1.8" fill="currentColor" />
        </svg>
      );
    case "debian":
      // Simplified "swirl" — open quarter-circle.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path
            d="M16.8 13a6 6 0 1 1-4.3-8.3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M14.5 10.5a3.5 3.5 0 1 0-3.2 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case "fedora":
      // Blue circle with white "f" cutout.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <circle cx="12" cy="12" r="9.5" fill="currentColor" />
          <path
            d="M13.7 7.5c0-.7.6-1.2 1.3-1.2h1.4V8h-1c-.3 0-.5.2-.5.5v1.8h1.7v1.9h-1.7v5.3h-2v-5.3h-2.6c-1 0-1.8.8-1.8 1.8v3.5h-2v-3.6a3.6 3.6 0 0 1 3.6-3.6h2.8V7.5z"
            fill="var(--prossh-bg, #1a1a1a)"
          />
        </svg>
      );
    case "centos":
      // Four diamonds forming a plus.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path fill="currentColor" d="M12 2l3.2 3.2L12 8.4 8.8 5.2z" />
          <path fill="currentColor" d="M22 12l-3.2 3.2L15.6 12l3.2-3.2z" />
          <path fill="currentColor" d="M12 22l-3.2-3.2L12 15.6l3.2 3.2z" />
          <path fill="currentColor" d="M2 12l3.2-3.2L8.4 12l-3.2 3.2z" />
          <rect x="9.5" y="9.5" width="5" height="5" fill="currentColor" opacity="0.4" />
        </svg>
      );
    case "arch":
      // Triangle with inner triangle cut.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path
            d="M12 2.5L3 20.5h3.2L12 8.5l5.8 12H21L12 2.5z"
            fill="currentColor"
          />
          <path d="M8.5 17h7l-1-2h-5z" fill="currentColor" />
        </svg>
      );
    case "alpine":
      // Mountain peaks.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path
            fill="currentColor"
            d="M2 19l5.5-9 3.5 5 2-3 4.5 7zm6-13a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"
          />
        </svg>
      );
    case "freebsd":
      // Red-ish devil "horns" — simplified as a shield.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path
            fill="currentColor"
            d="M12 3c2.8 0 6.2.6 8 2-.4 3-.6 4.5-.8 6.2-.3 3.3-2.7 8.8-7.2 10.3-4.5-1.5-6.9-7-7.2-10.3C4.6 9.5 4.4 8 4 5c1.8-1.4 5.2-2 8-2z"
          />
          <path
            fill="var(--prossh-bg, #1a1a1a)"
            d="M9 9l1.5 2-1 2 2.5-1 2.5 1-1-2 1.5-2-2.5.5L12 7l-.5 2.5z"
          />
        </svg>
      );
    case "linux":
      // Tux — simplified penguin silhouette.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <path
            fill="currentColor"
            d="M12 2c-2.3 0-3.8 1.9-3.8 4.6 0 .9.2 1.7.5 2.3-1.3 1-2.4 2.9-2.4 5.5 0 2.9.9 5.3 2.3 7 .8.9 2 1.6 3.4 1.6s2.6-.7 3.4-1.6c1.4-1.7 2.3-4.1 2.3-7 0-2.6-1.1-4.5-2.4-5.5.3-.6.5-1.4.5-2.3C15.8 3.9 14.3 2 12 2z"
          />
          <ellipse cx="10.3" cy="6.2" rx="0.9" ry="1.2" fill="var(--prossh-bg, #1a1a1a)" />
          <ellipse cx="13.7" cy="6.2" rx="0.9" ry="1.2" fill="var(--prossh-bg, #1a1a1a)" />
          <circle cx="10.3" cy="6.4" r="0.35" fill="currentColor" />
          <circle cx="13.7" cy="6.4" r="0.35" fill="currentColor" />
          <path d="M10.8 8.3l1.2.7 1.2-.7-1.2-.9z" fill="#F2B200" />
        </svg>
      );
    case "unknown":
    default:
      // Server rack — generic fallback.
      return (
        <svg {...common}>
          {title && <title>{title}</title>}
          <rect x="3.5" y="4" width="17" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="6.5" cy="7.25" r="0.8" fill="currentColor" />
          <circle cx="6.5" cy="16.75" r="0.8" fill="currentColor" />
          <line x1="9.5" y1="7.25" x2="17" y2="7.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <line x1="9.5" y1="16.75" x2="17" y2="16.75" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
  }
}
