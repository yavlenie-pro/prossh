//! Parse `~/.ssh/config` and convert Host blocks into session import candidates.

use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use serde::Serialize;
use ssh2_config::{ParseRule, SshConfig};

use crate::error::AppError;

/// One discovered SSH host entry from `~/.ssh/config`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigEntry {
    /// The `Host` pattern alias (e.g. `"prod-server"`).
    pub alias: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
}

/// Locate the default SSH config path for the current OS.
pub fn default_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("config"))
}

/// Parse an SSH config file and extract importable entries.
///
/// Entries with wildcard-only patterns (`*`, `*.*`) are skipped because they
/// represent defaults, not real hosts.
pub fn parse(path: &Path) -> Result<Vec<SshConfigEntry>, AppError> {
    let file = fs::File::open(path)
        .map_err(|e| AppError::Internal(format!("cannot open {}: {e}", path.display())))?;
    let mut reader = BufReader::new(file);

    let config = SshConfig::default()
        .parse(&mut reader, ParseRule::ALLOW_UNKNOWN_FIELDS)
        .map_err(|e| AppError::Internal(format!("ssh config parse error: {e}")))?;

    let mut entries = Vec::new();

    for host in config.get_hosts() {
        // Build a human-readable alias from the pattern clauses.
        let alias: String = host
            .pattern
            .iter()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join(" ");

        // Skip wildcard-only defaults
        let is_wildcard_only = host.pattern.iter().all(|c| {
            !c.negated && c.pattern.chars().all(|ch| ch == '*' || ch == '.' || ch == ' ')
        });
        if is_wildcard_only {
            continue;
        }

        // Skip purely negated entries
        if host.pattern.iter().all(|c| c.negated) {
            continue;
        }

        let params = &host.params;

        let identity_file = params
            .identity_file
            .as_ref()
            .and_then(|files| files.first())
            .map(|p| p.display().to_string());

        entries.push(SshConfigEntry {
            alias,
            host: params.host_name.clone(),
            port: params.port,
            user: params.user.clone(),
            identity_file,
        });
    }

    Ok(entries)
}
