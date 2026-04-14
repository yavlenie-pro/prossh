//! Unified error type for all Tauri commands.
//!
//! `AppError` implements `serde::Serialize` so it can be returned directly from
//! `#[tauri::command]` functions — Tauri turns it into a JS-side rejection.

use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("setup error: {0}")]
    Setup(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("database error: {0}")]
    Database(String),

    #[error("secret store error: {0}")]
    Secret(String),

    #[error("ssh error: {0}")]
    Ssh(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        // Serialize as a tagged object so the frontend can branch on the kind
        // without parsing the human-readable message.
        let (kind, message) = match self {
            AppError::Setup(m) => ("setup", m.clone()),
            AppError::Io(e) => ("io", e.to_string()),
            AppError::Serde(e) => ("serde", e.to_string()),
            AppError::Database(m) => ("database", m.clone()),
            AppError::Secret(m) => ("secret", m.clone()),
            AppError::Ssh(m) => ("ssh", m.clone()),
            AppError::NotFound(m) => ("not_found", m.clone()),
            AppError::InvalidArgument(m) => ("invalid_argument", m.clone()),
            AppError::Internal(m) => ("internal", m.clone()),
        };

        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("kind", kind)?;
        map.serialize_entry("message", &message)?;
        map.end()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        AppError::Internal(value.to_string())
    }
}
