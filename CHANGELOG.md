# Changelog

All notable changes to **ProSSH** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-05-08

### Added
- SFTP file browser shows a virtual `..` row at the top whenever the
  current directory is not a filesystem root, in both the sidebar
  view and the dual-pane SFTP tab. Double-clicking ascends one level.
  Hidden at POSIX `/` and Windows drive roots. The sidebar row also
  accepts internal drops so an entry can be moved one level up by
  dragging onto it. Rendered with a Г-shaped corner-arrow icon.
- Tabs in the title bar can now be reordered by drag-and-drop. A thin
  accent bar between tabs marks the prospective insert position; the
  dragged tab dims for visual feedback. Implementation uses manual
  mouse tracking rather than the HTML5 dnd API because Tauri 2 on
  Windows installs an OS-level drag-drop handler (required by the
  sidebar file browser for OS file uploads) that hijacks the mouse
  mid-drag and breaks the native dnd path.

## [0.1.1] — 2026-05-04

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
- The `R` reconnect hotkey is now layout-independent (binds to the physical
  key via `e.code`, so it fires on Russian and other non-Latin layouts) and
  fires from any focus inside the active tab. A disconnected pane in a
  hidden tab no longer steals `R` from a connected terminal in the visible
  tab.
- SFTP file browser now preserves the working directory when switching
  between tabs. Previously switching away and back reset the browser to
  the initial directory.
