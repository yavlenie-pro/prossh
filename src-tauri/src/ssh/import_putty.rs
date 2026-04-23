//! Import sessions from PuTTY's Windows Registry store.
//!
//! PuTTY stores sessions at:
//! `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\<name>`
//!
//! Each sub-key has values like `HostName`, `PortNumber`, `UserName`,
//! `PublicKeyFile`, `Protocol`.

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PuttySession {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub private_key_path: Option<String>,
    pub protocol: String,
}

#[cfg(windows)]
pub fn read_putty_sessions() -> Result<Vec<PuttySession>, AppError> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let sessions_key = match hkcu.open_subkey("Software\\SimonTatham\\PuTTY\\Sessions") {
        Ok(k) => k,
        Err(_) => return Ok(Vec::new()), // PuTTY not installed
    };

    let mut sessions = Vec::new();

    for name in sessions_key.enum_keys().filter_map(Result::ok) {
        let sub = match sessions_key.open_subkey(&name) {
            Ok(k) => k,
            Err(_) => continue,
        };

        // URL-decode the session name (PuTTY uses %XX encoding)
        let decoded_name = url_decode(&name);

        let host: String = sub.get_value("HostName").unwrap_or_default();
        if host.is_empty() {
            continue; // Skip "Default Settings" and empty entries
        }

        let port: u32 = sub.get_value("PortNumber").unwrap_or(22);
        let username: String = sub.get_value("UserName").unwrap_or_default();
        let key_file: String = sub.get_value("PublicKeyFile").unwrap_or_default();
        let protocol: String = sub.get_value("Protocol").unwrap_or_else(|_| "ssh".into());

        // PuTTY stores PPK paths — convert to OpenSSH if it looks like .ppk
        let private_key = if key_file.is_empty() {
            None
        } else {
            Some(key_file)
        };

        sessions.push(PuttySession {
            name: decoded_name,
            host,
            port: port as u16,
            username: if username.is_empty() {
                "root".into()
            } else {
                username
            },
            private_key_path: private_key,
            protocol,
        });
    }

    sessions.sort_by_key(|s| s.name.to_lowercase());
    Ok(sessions)
}

#[cfg(not(windows))]
pub fn read_putty_sessions() -> Result<Vec<PuttySession>, AppError> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            } else {
                result.push('%');
                result.push_str(&hex);
            }
        } else {
            result.push(c);
        }
    }
    result
}
