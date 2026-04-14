//! Sessions & groups domain — models + repo layer.
//!
//! A [`Group`] is a hierarchical folder. The schema supports arbitrary nesting
//! but the MVP UI will keep it flat. A [`Session`] stores all connection
//! metadata except secrets — passwords and key passphrases live in the OS
//! keychain, keyed by [`secret_key`].

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub mod color_profiles;
pub mod repo;
pub mod scripts;

/// Authentication method for an SSH session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
    Agent,
}

impl AuthMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthMethod::Password => "password",
            AuthMethod::Key => "key",
            AuthMethod::Agent => "agent",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "password" => Some(Self::Password),
            "key" => Some(Self::Key),
            "agent" => Some(Self::Agent),
            _ => None,
        }
    }
}

/// A folder grouping related sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A saved connection target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub private_key_path: Option<String>,
    pub use_keychain: bool,
    pub description: Option<String>,
    pub color: Option<String>,
    /// Remote OS family — auto-detected on connect via `uname -s` (or Windows
    /// `ver`). Opaque lowercase string: `linux`, `ubuntu`, `debian`, `centos`,
    /// `fedora`, `arch`, `alpine`, `freebsd`, `macos`, `windows`. `None` until
    /// the first successful detection.
    pub os_type: Option<String>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Payload sent by the frontend when creating or updating a session.
/// `id` absent → create; `id` present and known → update.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub id: Option<String>,
    pub group_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub private_key_path: Option<String>,
    pub use_keychain: bool,
    pub description: Option<String>,
    pub color: Option<String>,
}

/// Payload for creating or updating a group.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    pub id: Option<String>,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: Option<i32>,
}

// ---------------------------------------------------------------------------
// Port forwarding
// ---------------------------------------------------------------------------

/// A saved port-forwarding rule attached to a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: String,
    pub session_id: String,
    pub forward_type: PortForwardType,
    pub label: Option<String>,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Payload sent by the frontend when creating or updating a port forward.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInput {
    pub id: Option<String>,
    pub session_id: String,
    pub forward_type: PortForwardType,
    pub label: Option<String>,
    pub bind_host: Option<String>,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: u16,
    pub enabled: Option<bool>,
}

/// Direction of a port forward.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PortForwardType {
    Local,
    Remote,
}

impl PortForwardType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "local" => Some(Self::Local),
            "remote" => Some(Self::Remote),
            _ => None,
        }
    }
}

/// Deterministic identifier used as the keychain entry name for a session's
/// credential. Derived from the session id so rename doesn't lose the secret.
pub fn secret_key(session_id: &str) -> String {
    format!("session::{session_id}")
}
