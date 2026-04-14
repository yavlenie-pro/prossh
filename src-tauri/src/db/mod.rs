//! SQLite persistence layer.
//!
//! We use a single [`rusqlite::Connection`] guarded by a [`parking_lot::Mutex`]
//! and shared via `Arc`. The command layer runs every query inside
//! [`tokio::task::spawn_blocking`] so the async runtime stays responsive.
//! That's plenty for an SSH client — we never issue thousands of concurrent
//! queries — and keeps us out of the r2d2/async-sqlite complexity for now.

use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::error::AppError;

pub mod migrations;

/// Shared database handle — cheap to clone (it's just an `Arc`).
#[derive(Clone)]
pub struct Database {
    pub conn: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for Database {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Database").finish_non_exhaustive()
    }
}

impl Database {
    /// Open (or create) the database at `path` and run all pending migrations.
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let conn = Connection::open(path)
            .map_err(|e| AppError::Database(format!("open {}: {e}", path.display())))?;

        // Enable foreign keys (off by default in SQLite) and use WAL mode so
        // readers don't block the writer. PRAGMAs can't be parameterised,
        // but these values are constants so there's no injection risk.
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .map_err(|e| AppError::Database(format!("set pragmas: {e}")))?;

        migrations::apply(&conn)?;

        tracing::info!(path = %path.display(), "database opened");
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}
