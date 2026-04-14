//! CRUD for user scripts (global + per-session).
//!
//! A script with `session_id = NULL` is global (shown for all sessions).
//! A script with a specific `session_id` only appears for that session.

use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub id: String,
    pub session_id: Option<String>,
    pub name: String,
    pub command: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInput {
    pub id: Option<String>,
    pub session_id: Option<String>,
    pub name: String,
    pub command: String,
    pub sort_order: Option<i64>,
}

/// List all scripts. If `session_id` is Some, returns global + that session's scripts.
/// If None, returns only global scripts.
pub fn list(conn: &Connection, session_id: Option<&str>) -> Result<Vec<Script>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, name, command, sort_order, created_at, updated_at
             FROM scripts
             WHERE session_id IS NULL OR session_id = ?1
             ORDER BY sort_order, name",
        )
        .map_err(|e| AppError::Database(format!("scripts list prepare: {e}")))?;

    let rows = stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok(Script {
                id: row.get(0)?,
                session_id: row.get(1)?,
                name: row.get(2)?,
                command: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| AppError::Database(format!("scripts list query: {e}")))?;

    let mut scripts = Vec::new();
    for row in rows {
        scripts.push(row.map_err(|e| AppError::Database(format!("scripts row: {e}")))?);
    }
    Ok(scripts)
}

/// List only global scripts.
pub fn list_global(conn: &Connection) -> Result<Vec<Script>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, name, command, sort_order, created_at, updated_at
             FROM scripts
             WHERE session_id IS NULL
             ORDER BY sort_order, name",
        )
        .map_err(|e| AppError::Database(format!("scripts list_global prepare: {e}")))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Script {
                id: row.get(0)?,
                session_id: row.get(1)?,
                name: row.get(2)?,
                command: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| AppError::Database(format!("scripts list_global query: {e}")))?;

    let mut scripts = Vec::new();
    for row in rows {
        scripts.push(row.map_err(|e| AppError::Database(format!("scripts row: {e}")))?);
    }
    Ok(scripts)
}

/// List scripts for a specific session only (no globals).
pub fn list_for_session(conn: &Connection, session_id: &str) -> Result<Vec<Script>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, name, command, sort_order, created_at, updated_at
             FROM scripts
             WHERE session_id = ?1
             ORDER BY sort_order, name",
        )
        .map_err(|e| AppError::Database(format!("scripts list_for_session prepare: {e}")))?;

    let rows = stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok(Script {
                id: row.get(0)?,
                session_id: row.get(1)?,
                name: row.get(2)?,
                command: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| AppError::Database(format!("scripts list_for_session query: {e}")))?;

    let mut scripts = Vec::new();
    for row in rows {
        scripts.push(row.map_err(|e| AppError::Database(format!("scripts row: {e}")))?);
    }
    Ok(scripts)
}

/// Create or update a script.
pub fn upsert(conn: &Connection, input: ScriptInput) -> Result<Script, AppError> {
    let now = Utc::now().to_rfc3339();
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let sort_order = input.sort_order.unwrap_or(0);

    conn.execute(
        "INSERT INTO scripts (id, session_id, name, command, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           command = excluded.command,
           sort_order = excluded.sort_order,
           session_id = excluded.session_id,
           updated_at = excluded.updated_at",
        rusqlite::params![id, input.session_id, input.name, input.command, sort_order, now],
    )
    .map_err(|e| AppError::Database(format!("scripts upsert: {e}")))?;

    Ok(Script {
        id,
        session_id: input.session_id,
        name: input.name,
        command: input.command,
        sort_order,
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Delete a script by id.
pub fn delete(conn: &Connection, id: &str) -> Result<(), AppError> {
    let n = conn
        .execute("DELETE FROM scripts WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| AppError::Database(format!("scripts delete: {e}")))?;
    if n == 0 {
        return Err(AppError::NotFound(format!("script {id}")));
    }
    Ok(())
}
