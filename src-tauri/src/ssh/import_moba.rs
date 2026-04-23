//! Import sessions from MobaXTerm.
//!
//! Two sources:
//! 1. **Windows Registry** — `HKCU\Software\Mobatek\MobaXterm\Sessions\<name>`
//! 2. **`.mxtsessions` export file** — INI-like bookmarks format
//!
//! Session entry format (type `#109#` = SSH):
//! ```text
//! name=#109#0%host%port%username%password%-1%-1%ssh_gw_host%ssh_gw_port%ssh_gw_user%...%private_key_path%...#font_config
//! ```
//!
//! Fields are `%`-separated inside the `#109#...#` region:
//!   [0] sub-type (0=SSH), [1] host, [2] port, [3] username,
//!   [4] password (empty), [5..6] -1, [7] gateway host (if bounce),
//!   [8] gateway port, [9] gateway user, [10..12] misc,
//!   [13] private key path, [14] gateway key path, [15..] rest.
//!
//! `.mxtsessions` file uses `[Bookmarks]` / `[Bookmarks_N]` sections
//! with `SubRep=FolderPath` for groups.

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobaSession {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub private_key_path: Option<String>,
    /// Group/folder path from the bookmarks hierarchy (e.g. "AEZA/STAGE")
    pub group: Option<String>,
}

// ── File-based import (.mxtsessions) ────────────────────────────────────

/// Parse a `.mxtsessions` export file and return SSH sessions.
pub fn parse_mxtsessions_file(path: &str) -> Result<Vec<MobaSession>, AppError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| AppError::Internal(format!("Failed to read {path}: {e}")))?;
    Ok(parse_mxtsessions(&content))
}

/// Parse the text content of a `.mxtsessions` file.
fn parse_mxtsessions(content: &str) -> Vec<MobaSession> {
    let mut sessions = Vec::new();
    let mut current_group: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();

        // Section header
        if line.starts_with('[') && line.ends_with(']') {
            // Reset group — will be set by SubRep= in this section
            current_group = None;
            continue;
        }

        // SubRep line → group path
        if let Some(rest) = line.strip_prefix("SubRep=") {
            let path = rest.trim();
            if !path.is_empty() {
                // MobaXTerm uses backslash; normalise to forward slash
                current_group = Some(path.replace('\\', "/"));
            }
            continue;
        }

        // Skip ImgNum and other metadata
        if line.starts_with("ImgNum=") || line.is_empty() {
            continue;
        }

        // Must be a session line: `name=#TYPE#params`
        if let Some(sess) = parse_session_line(line, &current_group) {
            sessions.push(sess);
        }
    }

    sessions.sort_by_key(|s| s.name.to_lowercase());
    sessions
}

/// Parse a single session line.
///
/// Format: `name=#109#0%host%port%user%...#font_config`
/// We only care about `#109#` (SSH sessions).
fn parse_session_line(line: &str, group: &Option<String>) -> Option<MobaSession> {
    // Split on first '='
    let (name, value) = line.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }

    // Value starts with `#TYPE#params`
    let value = value.trim();
    if !value.starts_with('#') {
        return None;
    }

    // Extract type and the rest: #109#0%host%port%...#font...
    // Split by '#' → ["", "109", "0%host%port%...", "font...", ...]
    let parts: Vec<&str> = value.split('#').collect();
    if parts.len() < 3 {
        return None;
    }

    let session_type = parts[1].trim();
    if session_type != "109" {
        return None; // Only SSH
    }

    // The SSH params section (may contain trailing `#` for font config)
    let ssh_params = parts[2];

    // Split SSH params by `%`
    let fields: Vec<&str> = ssh_params.split('%').collect();
    if fields.len() < 4 {
        return None;
    }

    // Field 0: sub-type (0 = regular SSH)
    // Field 1: host
    let host = fields[1].trim().to_string();
    if host.is_empty() {
        return None;
    }

    // Field 2: port
    let port: u16 = fields[2].trim().parse().unwrap_or(22);
    if port == 0 {
        return None;
    }

    // Field 3: username
    let username = fields[3].trim().to_string();

    // Field 13: private key path (if present)
    let private_key = fields.get(13).and_then(|s| {
        let s = s.trim();
        if s.is_empty() || s == "-1" {
            None
        } else {
            // Replace _ProfileDir_ placeholder — strip it since we don't know their profile dir
            let cleaned = s
                .replace("_ProfileDir_\\", "")
                .replace("_ProfileDir_/", "");
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        }
    });

    Some(MobaSession {
        name: name.to_string(),
        host,
        port,
        username: if username.is_empty() {
            "root".into()
        } else {
            username
        },
        private_key_path: private_key,
        group: group.clone(),
    })
}

// ── Registry-based import (Windows) ─────────────────────────────────────

#[cfg(windows)]
pub fn read_moba_sessions() -> Result<Vec<MobaSession>, AppError> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // Try both known paths
    let sessions_key = hkcu
        .open_subkey("Software\\Mobatek\\MobaXterm\\Sessions")
        .or_else(|_| hkcu.open_subkey("Software\\Mobatek\\MobaXterm\\M"));

    let sessions_key = match sessions_key {
        Ok(k) => k,
        Err(_) => return Ok(Vec::new()),
    };

    let mut sessions = Vec::new();

    for (name, value) in sessions_key.enum_values().filter_map(Result::ok) {
        let data = match value.to_string().strip_prefix("sz:") {
            Some(s) => s.to_string(),
            None => value.to_string(),
        };

        // MobaXTerm format: fields separated by %
        let fields: Vec<&str> = data.split('%').collect();
        if fields.len() < 4 {
            continue;
        }

        // Field 0: session type (109 = SSH)
        let session_type = fields[0].trim();
        if session_type != "109" {
            continue; // Only import SSH sessions
        }

        let host = fields[1].trim().to_string();
        if host.is_empty() {
            continue;
        }

        let port: u16 = fields[2].trim().parse().unwrap_or(22);
        let username = fields[3].trim().to_string();

        // Field 13 contains the private key path
        let private_key = fields.get(13).and_then(|s| {
            let s = s.trim();
            if s.is_empty() || s == "-1" {
                None
            } else {
                let cleaned = s
                    .replace("_ProfileDir_\\", "")
                    .replace("_ProfileDir_/", "");
                if cleaned.is_empty() { None } else { Some(cleaned) }
            }
        });

        sessions.push(MobaSession {
            name: name.clone(),
            host,
            port,
            username: if username.is_empty() {
                "root".into()
            } else {
                username
            },
            private_key_path: private_key,
            group: None,
        });
    }

    sessions.sort_by_key(|s| s.name.to_lowercase());
    Ok(sessions)
}

#[cfg(not(windows))]
pub fn read_moba_sessions() -> Result<Vec<MobaSession>, AppError> {
    Ok(Vec::new())
}
