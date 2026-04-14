# ProSSH — User Guide

**English** · [Русский](./USER_GUIDE.ru.md) · [中文](./USER_GUIDE.zh.md)

This guide walks through every feature in ProSSH. If you just want the elevator pitch, read the [README](../README.md) first.

---

## Table of contents

1. [Installation](#installation)
2. [First launch and data locations](#first-launch-and-data-locations)
3. [Sessions and groups](#sessions-and-groups)
4. [Connecting](#connecting)
5. [Authentication](#authentication)
6. [Host keys (TOFU)](#host-keys-tofu)
7. [Terminal, tabs and split panes](#terminal-tabs-and-split-panes)
8. [SFTP file browser](#sftp-file-browser)
9. [Editing remote files in your editor](#editing-remote-files-in-your-editor)
10. [Server-to-server copy](#server-to-server-copy)
11. [Port forwarding](#port-forwarding)
12. [Scripts and the command palette](#scripts-and-the-command-palette)
13. [Importing from other clients](#importing-from-other-clients)
14. [Color profiles](#color-profiles)
15. [Settings reference](#settings-reference)
16. [Keyboard shortcuts](#keyboard-shortcuts)
17. [Troubleshooting](#troubleshooting)

---

## Installation

Pick the artifact for your OS from the [Releases](https://github.com/yavlenie-pro/prossh/releases) page:

- **Windows** — `ProSSH_<version>_x64-setup.exe` (NSIS, recommended) or the `.msi` variant. Requires [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/); on Windows 11 it is preinstalled.
- **macOS** — `ProSSH_<version>_aarch64.dmg` for Apple Silicon, `ProSSH_<version>_x64.dmg` for Intel. The build is unsigned today; the first launch needs a right-click → **Open** to bypass Gatekeeper.
- **Linux** — `.deb` for Debian/Ubuntu derivatives or the portable `.AppImage`. You need `libwebkit2gtk-4.1` (installed automatically by the `.deb`) and a Secret Service provider (`gnome-keyring` or `kwallet`) for password storage.

## First launch and data locations

ProSSH creates two directories on first start:

| Purpose | Windows | macOS | Linux |
| --- | --- | --- | --- |
| SQLite database, debug log | `%APPDATA%\prossh\` | `~/Library/Application Support/prossh/` | `~/.local/share/prossh/` |
| Known hosts, editable JSON | `%APPDATA%\prossh\` (same) | `~/Library/Preferences/prossh/` | `~/.config/prossh/` |

Credentials are never stored in the database — they go into the OS keychain under the service name `prossh` (with a second service `prossh-keypass` for key passphrases).

## Sessions and groups

A **session** is a saved connection profile: host, port, user, auth method, description, optional color. Sessions live in the left sidebar.

- **New session** — sidebar → `+` button, or the command palette action **New session**.
- **Groups** — right-click the sidebar → **New group**. Drag sessions into a group from the session's context menu → **Move to group**.
- **Search** — the search field in the sidebar filters by name, host, username or description.
- **Rename** — double-click the session name in the detail panel, or use its context menu.
- **Duplicate** — context menu → **Duplicate**. Useful for cloning a session as a jump-host template.
- **Delete** — context menu → **Delete** (asks for confirmation).
- **Dedup** — settings → Sessions → **Remove duplicates** deletes sessions with identical `host:port+user` pairs, keeping the most recently used one.

Sessions carry a **last used** timestamp that drives the default sort order and appears in the details pane.

## Connecting

Select a session and press **Connect** (or hit `Enter` on a focused row). ProSSH will:

1. Resolve DNS and open a TCP socket (10 s timeout).
2. Negotiate the SSH protocol with `russh` (the default ciphers are modern: chacha20-poly1305, AES-GCM, ed25519, curve25519).
3. Verify the host key against `known_hosts.json`. A new key triggers a TOFU prompt; a changed key is refused with an error in the terminal.
4. Authenticate using the configured method (see [Authentication](#authentication)).
5. Request a PTY, open a shell, wire stdout/stderr into the xterm panel.
6. Probe `uname -s` / Windows `ver` in the background to detect the remote OS family — purely cosmetic (shows the right icon in the session list).

**Test** (in the session details pane) does steps 1-4 without opening a PTY — it's the fastest way to validate credentials.

## Authentication

Three methods are supported:

- **Password** — typed once and optionally saved to the OS keychain (`Store password in OS keychain` checkbox). If you don't store it, ProSSH prompts every connect.
- **Private key** — point at a private key file (OpenSSH or PEM). If the key is encrypted, ProSSH shows a passphrase dialog on connect; the passphrase can also be stored in the keychain.
- **SSH agent** — delegates auth to the running agent (`pageant` on Windows with PuTTY, `ssh-agent` on macOS/Linux, Windows 10+ has a built-in one).

Supported key formats: `RSA`, `ECDSA`, `Ed25519` (both OpenSSH and PEM encodings). If the server sends `publickey` to your agent/key and the server rejects it, ProSSH will fall back to a **Credentials** dialog where you can enter a password instead.

## Host keys (TOFU)

First connect to a new host → **Unknown host key** dialog. It shows:

- Algorithm (e.g. `ssh-ed25519`)
- SHA-256 fingerprint (`SHA256:Qw…`)

Verify the fingerprint against a trusted out-of-band source before clicking **Accept & Trust**. Rejecting simply closes the connection without saving anything.

**Mismatch** — if the server presents a different key than the one you accepted previously, ProSSH refuses the connection (`Host key mismatch — refused`) and keeps the old entry. To override, open **Settings → Known hosts**, find the `host:port` row, click **Revoke**, and re-connect.

**Managing known hosts** — Settings → **Known hosts** lists every trusted entry with the add date. You can revoke a single entry or clear all keys for a host at once.

## Terminal, tabs and split panes

Each connection opens as a **tab** in the top tab bar. Click the tab label to switch, click `×` to close. Middle-click also closes.

**Split panes** — with a terminal tab active:

- `Ctrl+Shift+D` or palette → **Split pane horizontally** — adds a pane to the right.
- `Ctrl+Shift+E` or palette → **Split pane vertically** — adds a pane below.
- Click any pane to focus it; the active pane has a subtle border highlight.
- Drag the split divider to resize. Close a pane via its own `×`; the last pane closes the tab.

**Terminal controls**:

- Copy on select — if enabled in settings, any selection is auto-copied to the clipboard.
- Right-click paste — paste from clipboard without going through the system menu.
- Search — `Ctrl+F` inside the terminal opens the inline search.
- Reconnect — pressing `R` on a disconnected pane reconnects the session.

**URL detection** — `http://` / `https://` / `ssh://` links in the terminal output are clickable and open in the default browser / client.

## SFTP file browser

Switch the sidebar to **Files**. Selecting a session auto-opens an SFTP channel on the same connection.

- Navigate with the breadcrumb bar, `Back` / `Forward` arrows or by typing a path.
- **Upload** — drag files from the OS onto the panel, or use the **Upload** button. A transfer queue at the bottom shows progress and ETA; cancel individual transfers with `×`.
- **Download** — right-click a file → **Download**.
- **Rename** / **Delete** / **New file** / **New directory** / **chmod** — right-click context menu.
- **Drop out** — drag a remote file to a native OS window (Finder, Explorer) to download it to that location.
- **Open** — right-click → **Open** on a directory enters it; on a file, **Open in default app** downloads to a temp file and launches the OS handler.
- **Open SFTP in tab** — turns the side panel into a full-screen dual-pane view.

## Editing remote files in your editor

Right-click any remote file → **Edit in editor**:

1. ProSSH downloads the file to a temp path.
2. Opens it in the configured editor (first-time picker lets you browse for `code`, `subl`, `micro`, etc.).
3. Watches the local file for changes.
4. On every save, uploads the new content back to the server (if **Auto** is enabled; otherwise click **Upload** in the Transfers panel).
5. Click **Stop watching** to end the session; the temp file is removed.

Large files, binary blobs and directories are excluded from the watcher.

## Server-to-server copy

Need to move a file from server A to server B without staging it through your laptop? Right-click a file/dir on server A's SFTP panel → **Copy to server…**

A wizard walks through:

1. **Pick destination session** and the target path.
2. ProSSH checks whether `rsync` or `scp` is installed on **source**. If not — offers to install it (via the detected package manager).
3. ProSSH looks for `~/.ssh/id_ed25519` on source. If not — offers to generate one.
4. ProSSH uploads the **public** key to destination's `authorized_keys` (prompting for destination's password).
5. Transfer runs on the source server itself, with live progress streamed into the wizard.
6. Optional cleanup removes the temporary key pair from source and destination after transfer.

This is dramatically faster than the "download locally → upload to other server" pattern for large payloads because the bytes never leave the datacenter.

## Port forwarding

Per-session forwarding rules live under the session editor → **Port Forwarding** section:

- **Local** — `-L` direction. Binds `bind_host:bind_port` on your machine; requests to that socket are tunneled to `target_host:target_port` from the SSH server's perspective.
- **Remote** — `-R` direction. Binds on the SSH server; forwards back to `target_host:target_port` reachable from your machine.

Rules are enabled by default and activate automatically on every connect. Disable individual rules (or delete them) without dropping the session.

## Scripts and the command palette

A **script** is a bash snippet with a name. Press `Ctrl+Shift+P` to open the command palette, type part of the script name, `Enter` — the script text is typed into the current terminal pane.

- **Global scripts** — available from any session. Manage in Settings → **Scripts**.
- **Per-session scripts** — tied to one session, shown above global scripts when that session is focused. Manage in the session editor → **Scripts** tab.

The palette also surfaces all sessions (connect / SFTP variants), split actions, settings and theme switch. It is the single fastest way to get around.

## Importing from other clients

Sidebar `+` → **Import from…** (or palette search for "Import").

- **SSH config** — parses `~/.ssh/config`, preserves `HostName` / `Port` / `User` / `IdentityFile`. You pick which `Host` entries to import.
- **PuTTY (Windows only)** — reads saved sessions from `HKCU\Software\SimonTatham\PuTTY\Sessions`.
- **MobaXterm (Windows only)** — reads from the Registry, or lets you load a `.mxtsessions` export file. Folders in MobaXterm become groups in ProSSH (toggle the checkbox).

Imported sessions default to **password** auth if no key is specified. You'll be asked for the password on first connect (and offered to save it to the keychain).

## Color profiles

Settings → **Appearance** → **Color Profile**. ProSSH ships with several built-in themes:

- Windows Terminal Campbell / One Half Dark / One Half Light
- Solarized Dark / Solarized Light
- Dracula, Nord, Gruvbox, Tokyo Night

Create a custom profile by cloning any built-in, changing colors in the editor, and saving. Built-in profiles cannot be modified directly (edit creates a copy).

Profile change applies to **newly opened** terminals; existing panes keep the color they opened with until closed.

## Settings reference

| Section | Setting | What it does |
| --- | --- | --- |
| Appearance | Language | UI language (English / Russian / 中文). Takes effect on next launch. |
| Appearance | Color Profile | Default terminal color scheme. |
| Terminal | Right-click to paste | If on, right-click pastes clipboard into terminal. If off, opens context menu. |
| Terminal | Copy on select | Auto-copy selections. |
| Terminal | Remember last SFTP directory | Restores the last visited SFTP path when reconnecting. |
| Terminal | Restore sessions on startup | Reopens terminal & SFTP tabs that were open when the app was closed. |
| Terminal | Switch to SFTP on connect | After connect, auto-switches the sidebar to the file browser. |
| Monitoring | CPU / RAM / GPU interval | Fast-poll interval for lightweight metrics. |
| Monitoring | Disks / System info interval | Slow-poll interval for disk usage and host info. |
| Sessions | Remove duplicates | Deduplicates sessions by `host:port:user`. |
| Known hosts | Reload, Revoke, Clear host | Manage trusted host keys. |
| Keyboard | Shortcuts | Read-only list of global shortcuts. |

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+T` | New tab for the selected session |
| `Ctrl+W` | Close active tab |
| `Ctrl+Shift+D` | Split pane horizontally |
| `Ctrl+Shift+E` | Split pane vertically |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+F` (in terminal) | Inline search |
| `R` (on disconnected pane) | Reconnect |

On macOS, substitute `Ctrl` with `Cmd` where the system convention would expect it — ProSSH listens to both.

## Troubleshooting

**The app won't launch / no window appears (Windows).**  Check that WebView2 runtime is installed. On Windows 11 it's preinstalled; on Windows 10, grab it from [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/).

**"Connection to host:port timed out (10s)"** — the TCP handshake didn't complete. Firewall, VPN, wrong port, or the server is down. Try `ping host` / `nc -vz host port` from a terminal to narrow it down.

**"Public key rejected by server"** — the server's `authorized_keys` doesn't contain a matching public key. Verify with `ssh-keygen -y -f /path/to/key` that you have the right private key and append `/path/to/key.pub` to the remote `~/.ssh/authorized_keys`.

**"Host key mismatch — refused"** — the server's fingerprint changed since you last trusted it. This happens legitimately when the server OS is reinstalled, and illegitimately under a MITM. Settings → Known hosts → **Revoke** the stale entry after verifying the new fingerprint out-of-band.

**"No password stored for this session"** — you unchecked *Store password*. Open the session editor and save the password again, or switch to key auth.

**SFTP hangs on connect but terminal works.**  Some servers enforce per-user SFTP subsystem restrictions. Check `sshd_config` for `Subsystem sftp` and `Match User` blocks.

**Slow paste / clipboard failures on Linux.**  Make sure `xclip` or `wl-clipboard` is installed (xterm.js delegates clipboard ops to the system via Tauri).

**Desktop debug log.**  `%USERPROFILE%\Desktop\prossh-debug.log` on Windows (and the OS desktop on other platforms) contains early-boot diagnostics and resolve-event traces. Attach it when filing bugs.

Still stuck? Open an issue at <https://github.com/yavlenie-pro/prossh/issues> and include:

- OS name and version (`winver`, `sw_vers`, `uname -a`)
- ProSSH version (About dialog)
- Steps to reproduce
- `prossh-debug.log` if available
