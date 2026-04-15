//! Tauri IPC commands grouped by domain.
//!
//! Each submodule corresponds to one section of the architecture (sessions,
//! ssh lifecycle, sftp, secrets, settings, host_keys). Modules are added as
//! their milestones land.

pub mod known_hosts;
pub mod misc;
pub mod pty;
pub mod secrets;
pub mod sessions;
pub mod settings;
pub mod sftp;
pub mod ssh;
pub mod scripts;
pub mod sync;
pub mod system;
