# ProSSH — Development Guide

**English** · [Русский](./DEVELOPMENT.ru.md) · [中文](./DEVELOPMENT.zh.md)

Everything a contributor needs to build, run, test and extend ProSSH.

---

## Table of contents

1. [Repository layout](#repository-layout)
2. [Prerequisites](#prerequisites)
3. [Building and running](#building-and-running)
4. [Architecture](#architecture)
5. [IPC contract](#ipc-contract)
6. [Data model and migrations](#data-model-and-migrations)
7. [SSH and SFTP internals](#ssh-and-sftp-internals)
8. [Versioning and release flow](#versioning-and-release-flow)
9. [Code style](#code-style)
10. [Adding a feature: checklist](#adding-a-feature-checklist)
11. [Adding a new language](#adding-a-new-language)
12. [Debugging tips](#debugging-tips)
13. [CI](#ci)

---

## Repository layout

```
prossh/
├── .github/workflows/       # CI + release
├── docs/                    # this folder
├── public/                  # static assets (if any)
├── src/                     # React frontend
│   ├── api/                 # thin `invoke` wrappers per backend domain
│   ├── components/          # React UI, grouped by feature area
│   │   ├── dialogs/         # modal dialogs (connection, credentials, import, ...)
│   │   ├── layout/          # AppShell, StatusBar, TitleBar, SystemWidgets
│   │   ├── palette/         # Command palette (cmdk)
│   │   ├── panes/           # Split-pane view + leaf view
│   │   ├── sessions/        # session list + detail panel
│   │   ├── sftp/            # SFTP explorer
│   │   ├── sidebar/         # Sidebar root, FilesBrowser, TransferQueue
│   │   ├── settings/        # Settings dialog
│   │   ├── tabs/            # Tab bar
│   │   ├── terminal/        # xterm wrapper (TerminalView)
│   │   └── ui/              # generic primitives (Button, Input, Select, ...)
│   ├── hooks/               # reusable hooks (e.g. useXterm)
│   ├── i18n/                # i18next setup + JSON per locale
│   ├── lib/                 # utility helpers
│   ├── stores/              # Zustand stores
│   ├── styles/              # Tailwind globals + CSS variables
│   ├── App.tsx              # top-level component (loads theme, mounts AppShell)
│   └── main.tsx             # React entry + global CSS imports
├── src-tauri/               # Rust backend (Tauri app)
│   ├── build.rs             # tauri-build + version injection
│   ├── Cargo.toml
│   ├── capabilities/        # Tauri 2 permission capabilities
│   ├── examples/            # standalone binaries (`ssh_probe`, ...)
│   ├── icons/               # platform icons bundled into installers
│   ├── src/
│   │   ├── commands/        # #[tauri::command] handlers, grouped by domain
│   │   ├── db/              # rusqlite connection + migrations
│   │   ├── known_hosts/     # known_hosts.json store + TOFU policy
│   │   ├── secrets/         # OS keychain wrappers
│   │   ├── sessions/        # session repo, import (ssh-config, PuTTY, Moba)
│   │   ├── sftp/            # SFTP client + transfer queue
│   │   ├── ssh/             # russh session, PTY, auth, gates, port forwarding
│   │   ├── util/            # misc helpers
│   │   ├── error.rs         # AppError + IntoResponse
│   │   ├── lib.rs           # tauri::Builder, commands wiring, event listeners
│   │   ├── main.rs          # thin `fn main() { prossh_lib::run() }`
│   │   ├── state.rs         # AppState (paths, db, maps, gates)
│   │   └── themes.rs        # BUILTIN_PROFILES (color themes)
│   └── tauri.conf.json      # Tauri app config (title, bundle, csp, ...)
├── index.html
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 20 LTS or newer | `npm ci` uses `package-lock.json`. |
| Rust | 1.77+ (stable) | Install via [rustup](https://rustup.rs/). `cargo`, `rustc`, `clippy`, `rustfmt`. |
| Platform toolchain | see below | C linker for native deps. |

**Windows**: MSVC Build Tools 2019+ (aka Visual Studio Build Tools with the "Desktop development with C++" workload). WebView2 runtime is preinstalled on Windows 11. No NASM needed — `russh` is configured to use the pure-Rust `ring` crypto backend.

**macOS**: Xcode Command Line Tools (`xcode-select --install`). For universal binaries add both targets:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

**Linux** (Debian/Ubuntu; adapt for your distro):

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libdbus-1-dev \
  pkg-config \
  build-essential
```

> **Git Bash on Windows** — `cargo` is not automatically on `PATH`. Prefix commands with `PATH="/c/Users/$USER/.cargo/bin:$PATH"` or use PowerShell.

## Building and running

```bash
npm ci                       # install JS deps (first time)
npm run tauri dev            # hot-reload dev build
npm run tauri build          # release bundle → src-tauri/target/release/bundle/
```

Other useful scripts:

```bash
npm run dev                  # Vite dev server without Tauri (UI only, mock invoke)
npm run build                # tsc + vite build (no Tauri bundling)
npm run lint                 # ESLint
npm run format               # Prettier

# Inside src-tauri/:
cargo check                  # fast type-check (≈ 30 s incremental)
cargo clippy -- -D warnings  # lint the Rust side
cargo test                   # run Rust unit tests
cargo fmt --all              # format Rust sources
```

**Windows tip** — the running `prossh.exe` holds a lock on the binary. Before `npm run tauri build`, kill any running instance:

```bash
powershell -Command "Stop-Process -Name prossh -Force -ErrorAction SilentlyContinue"
```

**First release build** — expect 3-5 minutes on a fast machine. Subsequent builds with [`Swatinem/rust-cache`](https://github.com/Swatinem/rust-cache) (used by CI) take ~1 minute.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Renderer (WebView / Vite / React)                                  │
│                                                                      │
│   TerminalView   SftpExplorer   Sidebar    Dialogs    Palette        │
│        │              │            │          │          │          │
│        └──────────────┴────────────┼──────────┴──────────┘           │
│                                    ▼                                 │
│                             Zustand stores                          │
│                                    │                                 │
│                            @tauri-apps/api invoke                   │
└────────────────────────────────────┼────────────────────────────────┘
                                     │   IPC (JSON)
┌────────────────────────────────────▼────────────────────────────────┐
│  Rust backend (Tauri 2 runtime)                                    │
│                                                                      │
│   commands::*  ─►  domain modules                                   │
│                    ├─ ssh::pty      (russh sessions + PTY)          │
│                    ├─ ssh::forward  (-L / -R tunnels)               │
│                    ├─ sftp::client  (russh-sftp)                    │
│                    ├─ sessions::repo  (SQLite CRUD)                 │
│                    ├─ known_hosts    (JSON store + TOFU)            │
│                    └─ secrets        (keyring crate)                │
│                                                                      │
│           AppState  { db, ssh_sessions, sftp_sessions,               │
│                       passphrase_gate, host_key_gate,                │
│                       credentials_gate, known_hosts, ... }          │
│                             ▲           ▲                            │
│                             │           │                            │
│  OS keychain ◄──────┘       │      ┌────▼────┐                       │
│  (Credential Manager /      │      │ SQLite  │  prossh.sqlite        │
│   Keychain / libsecret)     │      └─────────┘                       │
│                             │                                        │
│                      Tauri events ─►  host-key / passphrase /         │
│                                       credentials prompts             │
└────────────────────────────────────────────────────────────────────┘
```

**Why `AppState` is held via `tauri::State`** — every command accepts `State<'_, AppState>` and clones only the cheap `Arc`-wrapped sub-fields. The `Database` is `Arc<Mutex<Connection>>`, ssh/sftp maps are `Arc<RwLock<HashMap<_, Arc<…>>>>`, so command handlers never block each other except for actual SQLite serialization.

**Why `tokio::task::spawn_blocking` around rusqlite** — SQLite is synchronous; wrapping every query in `spawn_blocking` keeps the async runtime responsive. Throughput isn't an issue here (we're an SSH client, not a database server).

**Prompt gates** — host-key / passphrase / credentials prompts cannot use the normal `invoke` return path: WebView2 serializes IPC calls, so an open `open_session` invoke would block the response of the prompt dialog's invoke, deadlocking the app. Instead, the backend emits a Tauri event, the dialog sends a `resolve-*` event back, and the backend's async gate `oneshot` channel resolves. See [`ssh/gate.rs`](../src-tauri/src/ssh/gate.rs) and the listener setup in [`lib.rs`](../src-tauri/src/lib.rs).

## IPC contract

All commands live in `src-tauri/src/commands/` and are registered in the `invoke_handler!` macro in [`lib.rs`](../src-tauri/src/lib.rs). TypeScript wrappers mirror them in `src/api/*.ts`.

**Naming convention** — Rust commands use `snake_case` (`sftp_list`, `open_session`, `known_hosts_remove`). The TS wrappers re-export under the same name.

**Serde** — all types shared with the frontend use `#[serde(rename_all = "camelCase")]`. Shared type definitions live in `src/api/types.ts` and must be kept in sync with Rust structs by hand.

**Errors** — every command returns `Result<T, AppError>`. `AppError` serialises to `{ kind, message }` (see `src-tauri/src/error.rs`). On the frontend, call sites treat rejections as `AppError` (see `src/api/types.ts`).

**Events** — used for one-way notifications and the prompt gate pattern:

| Event | Direction | Payload |
| --- | --- | --- |
| `pty://data/<runtime_id>` | Rust → JS | stdout/stderr chunks as `Uint8Array` |
| `pty://exit/<runtime_id>` | Rust → JS | exit info, closes the terminal |
| `pty://connected/<runtime_id>` | Rust → JS | emitted after auth succeeds |
| `pty://error/<runtime_id>` | Rust → JS | structured error object |
| `resolve-host-key` | JS → Rust | `{ prompt_id, accept: bool }` |
| `resolve-passphrase` | JS → Rust | `{ prompt_id, passphrase: string }` |
| `resolve-credentials` | JS → Rust | `{ prompt_id, username, password }` |
| `transfer://progress/<transfer_id>` | Rust → JS | SFTP transfer progress |

## Data model and migrations

Schema migrations live in [`src-tauri/src/db/migrations.rs`](../src-tauri/src/db/migrations.rs). Version is stored in SQLite's built-in `PRAGMA user_version`, there is no bookkeeping table.

Adding a migration:

1. Bump `CURRENT_VERSION` by 1.
2. Add a new `apply_vN` function with the schema changes.
3. Route the match arm in `apply()`.
4. **Never edit an already-shipped migration** — it runs on user machines only once.

Current tables:

| Table | Purpose |
| --- | --- |
| `groups` | Session folders (tree via `parent_id`). |
| `sessions` | Saved connections (host, port, user, auth_method, ...). |
| `color_profiles` | Built-in and custom terminal themes. |
| `settings` | Key/value pairs for app preferences. |
| `scripts` | Global (`session_id IS NULL`) and per-session scripts. |
| `port_forwards` | Local/remote tunnels per session. |

Secrets never touch SQLite. Passwords live under keyring service `prossh` with `session_id` as the account name; key passphrases under `prossh-keypass`.

## SSH and SFTP internals

**Crate choice** — [`russh`](https://github.com/warp-tech/russh) (pure Rust). We explicitly disable `aws-lc-rs` (needs NASM on Windows) and use the `ring` backend with `flate2` + `rsa` features. See `src-tauri/Cargo.toml`.

**Session lifecycle**:

1. `commands::pty::open_session` resolves DNS, opens TCP, hands the socket to `russh::client::connect_stream`.
2. Host key check runs first via `KnownHostsStore::check`, which routes through `host_key_gate` if a prompt is needed.
3. Auth attempts try `publickey` (agent → key file) then `password`, prompting via `credentials_gate` if the server rejects pubkey or no password is stored.
4. On success, request a PTY, spawn a Tokio task that pumps `ChannelMsg::Data` into `pty://data/<id>` events.
5. Port forwards from `port_forwards` table are registered on the same client handle.
6. `close_session` sends `disconnect` and cleans up the map entry.

**SFTP** rides on a separate channel from the same `russh::client::Handle`, created via `russh_sftp::client::SftpSession::new`. Transfers are chunked with a cancellation token per `transfer_id` stored in `AppState::transfer_cancellations`.

**Gracefull shutdown** — in `RunEvent::ExitRequested`, `ssh::pty::close_all` is called with a 3 s timeout to flush pending data before the process exits. See the `run()` tail in `lib.rs`.

## Versioning and release flow

The binary exposes its version through the `app_version` IPC command, which reads the build-time constant `PROSSH_VERSION` (set by [`src-tauri/build.rs`](../src-tauri/build.rs)).

**Version resolution order** (in `build.rs`):

1. Env var `PROSSH_BUILD_VERSION` if set — used verbatim.
2. Otherwise `CARGO_PKG_VERSION` from `Cargo.toml`, optionally suffixed with `+sha.<shortSHA>` if the build happens inside a git checkout.

The frontend calls `app_version` once on mount and shows the value in the status bar (bottom right) and on the About panel. Do not hardcode the version in the UI.

**CI wiring**:

- [`ci.yml`](../.github/workflows/ci.yml) — pushes to `main` / `prod` and PRs. Sets `PROSSH_BUILD_VERSION=<Cargo>-dev.<run_number>+sha.<shortSHA>`.
- [`release.yml`](../.github/workflows/release.yml) — runs on tags `v*`. Sets `PROSSH_BUILD_VERSION=<ref_name stripped of leading "v">`.

**Cutting a release**:

1. Bump `version` in `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and `package.json` (same value in all three).
2. Commit with `chore: release vX.Y.Z`.
3. Tag: `git tag vX.Y.Z && git push --tags`.
4. GitHub Actions drafts a release with installers for every platform.
5. Edit the drafted release notes, publish.

## Code style

**Rust**:

- `rustfmt` defaults (4-space indent, 100-col width). Run `cargo fmt --all` before pushing.
- `cargo clippy -- -D warnings` must pass — CI enforces it.
- Error propagation: domain-specific `AppError` variants (`Io`, `Database`, `Ssh`, `Secret`, `NotFound`, `InvalidArgument`, …) over `anyhow::Error` at command boundaries. `anyhow` is fine inside modules.
- Comments: **write why, not what.** Prefer a short `///` doc comment on public items over inline comments explaining Rust syntax.
- Async: use `tokio` throughout. Don't mix `async-std` or `smol`.
- Logging: `tracing::{debug,info,warn,error}` with structured fields — e.g. `tracing::info!(session_id = %id, "connected");`.

**TypeScript / React**:

- Prettier + ESLint (TS + React plugins). `npm run lint` must pass.
- Prefer function components and hooks. No class components.
- State: Zustand stores for shared app state, `useState` for local UI state. Don't reach for Redux.
- Data fetching: call `invoke` directly from stores or components; thin wrappers in `src/api/*.ts`. No React Query for now (Tauri IPC is fast and rarely needs retry/cache logic).
- CSS: Tailwind + a small number of CSS custom properties in `styles/globals.css` for theme colors (`--prossh-bg`, `--prossh-fg`, `--prossh-accent`, …).
- Imports: absolute imports via the `@/` alias (see `tsconfig.json` + `vite.config.ts`).

**Branding in code**:

- UI strings: `ProSSH` (capital P, capital SSH).
- Technical identifiers: `prossh` (snake_case-ish). Applies to npm name, cargo crate name, bundle id segments, paths, env vars, keyring service names, SQL identifiers.

## Adding a feature: checklist

Let's say you're adding "session tags" (free-form labels on sessions).

1. **Database migration** — add `apply_v6` that creates `session_tags` with FK to `sessions`.
2. **Rust domain module** — extend `src-tauri/src/sessions/repo.rs` (or create a new module) with CRUD functions.
3. **IPC commands** — `src-tauri/src/commands/sessions.rs`, add `tags_list`, `tags_set`. Wire them in `lib.rs`'s `invoke_handler!`.
4. **TypeScript types** — mirror the structs in `src/api/types.ts` and add thin `invoke` wrappers in `src/api/sessions.ts`.
5. **Store** — extend `src/stores/sessions.ts` if you need reactive state for tags.
6. **UI** — add a `TagsEditor` component, surface it in `SessionDetails` and/or the session editor dialog.
7. **i18n** — add translation keys in `en.json`, mirror in `ru.json` and `zh.json`. **Don't ship English-only keys.**
8. **Tests** — Rust unit tests for the repo functions. UI tests are not wired up today; manual click-through is the current baseline.
9. **Docs** — document the feature in `docs/USER_GUIDE.md` (all three languages).
10. **Changelog** — append to `CHANGELOG.md` (create it if it doesn't exist yet).

## Adding a new language

1. Copy `src/i18n/en.json` to `src/i18n/<code>.json`.
2. Translate every key. Watch for placeholder syntax (`{{count}}`, `{{name}}`) — leave those intact.
3. Register the locale in `src/i18n/index.ts`:

   ```ts
   import fr from "./fr.json";
   // resources: { en: …, ru: …, zh: …, fr: { translation: fr } },
   ```

4. Add the language option in `src/components/settings/SettingsDialog.tsx` (language dropdown) and a `settings.lang<Code>` key in every locale file.
5. Translate the documentation: `README.<code>.md`, `docs/USER_GUIDE.<code>.md`, `docs/DEVELOPMENT.<code>.md`, and update the language switcher links in all existing docs.

## Debugging tips

- **Frontend** — WebView2 DevTools: right-click anywhere (when context menu is enabled) or `F12`. In release builds DevTools are stripped; build with `npm run tauri dev` to inspect.
- **Backend logs** — `tracing_subscriber` filters via the `RUST_LOG` env var:

  ```bash
  RUST_LOG=prossh=debug,russh=info npm run tauri dev
  ```

- **Desktop log file** — `prossh-debug.log` on the user's desktop collects early-boot diagnostics and prompt-gate events. Useful when DevTools aren't available.
- **Rust stack traces** — set `RUST_BACKTRACE=1`; `RUST_BACKTRACE=full` for every frame.
- **Standalone SSH probes** — `src-tauri/examples/ssh_probe.rs` and `ssh_probe_mismatch.rs` can be run independently to test host-key behaviour: `cargo run --example ssh_probe -- <host> <user>`.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every PR and push to `main` / `prod`:

- Matrix: `windows-latest`, `macos-latest`, `ubuntu-22.04`.
- Steps: install system deps (Linux only) → `npm ci` → `tsc --noEmit` → `cargo check` → `cargo clippy -- -D warnings`.
- Rust build cache via `Swatinem/rust-cache@v2`.

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on `v*` tag pushes and via `workflow_dispatch`:

- Matrix: `windows-latest`, `macos-latest` (aarch64 + x86_64), `ubuntu-22.04`.
- Uses `tauri-apps/tauri-action@v0` to produce platform installers and attach them to a **draft** GitHub release.
- Edit the release notes and publish manually when you're ready.

Both workflows set `PROSSH_BUILD_VERSION` so the version you see in the status bar and About panel matches exactly what the bundle contains.
