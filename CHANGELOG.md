# Changelog

All notable changes to **ProSSH** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Full keyboard navigation in the sessions sidebar: `Enter` / `↓` in the
  search field jumps to the first match; `↑` / `↓` walk between rows;
  `Enter` connects; `↑` on the first row or `Esc` returns to the search
  field. Focused rows now show a discreet accent ring instead of the
  browser's default white outline, and only when the user is actually
  driving with the keyboard (`focus-visible`).
- Clicking a tab now moves focus straight into that tab's terminal, so the
  next keystroke lands on the shell instead of the tab strip. Also applies
  when the active tab changes via the command palette, tab close, or
  session restore on startup.

### Changed
- SFTP transfers (upload, download, server-to-server copy) now pipeline up to
  16 read/write requests over a dedicated raw SFTP channel. Previously the
  high-level wrapper serialised one request per round-trip, capping throughput
  over high-latency links. The same path backs drag-to-desktop and external
  editor downloads.

### Fixed
- Dropping a file from the OS onto the file browser could fire the upload
  twice when the drag-drop listener re-subscribed before its unlisten handle
  had arrived from the Tauri IPC round-trip. The subscription is now guarded
  so the stale handler is disposed as soon as it lands.
