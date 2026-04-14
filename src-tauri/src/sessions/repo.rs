//! Synchronous SQLite queries for groups & sessions.
//!
//! These functions take a borrowed `&Connection` and are intentionally
//! blocking — the Tauri command layer wraps every call in
//! [`tokio::task::spawn_blocking`] to keep the async runtime responsive.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use super::{AuthMethod, Group, GroupInput, PortForward, PortForwardInput, PortForwardType, Session, SessionInput};
use crate::error::AppError;

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn parse_ts(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn db_err<E: std::fmt::Display>(op: &'static str) -> impl FnOnce(E) -> AppError {
    move |e| AppError::Database(format!("{op}: {e}"))
}

// ---------------------------------------------------------------- groups ----

pub fn list_groups(conn: &Connection) -> Result<Vec<Group>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, parent_id, sort_order, created_at, updated_at
             FROM groups
             ORDER BY sort_order, name",
        )
        .map_err(db_err("prepare list_groups"))?;
    let rows = stmt
        .query_map([], row_to_group)
        .map_err(db_err("query list_groups"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(db_err("collect list_groups"))
}

pub fn upsert_group(conn: &Connection, input: GroupInput) -> Result<Group, AppError> {
    let now = now_rfc3339();

    if let Some(id) = input.id.clone() {
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM groups WHERE id = ?1",
                params![&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err("check group existence"))?;

        if exists.is_some() {
            conn.execute(
                "UPDATE groups
                    SET name = ?1,
                        parent_id = ?2,
                        sort_order = ?3,
                        updated_at = ?4
                  WHERE id = ?5",
                params![
                    input.name,
                    input.parent_id,
                    input.sort_order.unwrap_or(0),
                    now,
                    id,
                ],
            )
            .map_err(db_err("update group"))?;
            return fetch_group(conn, &id);
        }
    }

    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    conn.execute(
        "INSERT INTO groups (id, name, parent_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![
            id,
            input.name,
            input.parent_id,
            input.sort_order.unwrap_or(0),
            now,
        ],
    )
    .map_err(db_err("insert group"))?;
    fetch_group(conn, &id)
}

pub fn fetch_group(conn: &Connection, id: &str) -> Result<Group, AppError> {
    conn.query_row(
        "SELECT id, name, parent_id, sort_order, created_at, updated_at
         FROM groups WHERE id = ?1",
        params![id],
        row_to_group,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("group {id}")),
        other => AppError::Database(format!("fetch group: {other}")),
    })
}

pub fn delete_group(conn: &Connection, id: &str) -> Result<(), AppError> {
    let rows = conn
        .execute("DELETE FROM groups WHERE id = ?1", params![id])
        .map_err(db_err("delete group"))?;
    if rows == 0 {
        return Err(AppError::NotFound(format!("group {id}")));
    }
    Ok(())
}

fn row_to_group(row: &Row<'_>) -> rusqlite::Result<Group> {
    let created_at: String = row.get("created_at")?;
    let updated_at: String = row.get("updated_at")?;
    Ok(Group {
        id: row.get("id")?,
        name: row.get("name")?,
        parent_id: row.get("parent_id")?,
        sort_order: row.get("sort_order")?,
        created_at: parse_ts(&created_at),
        updated_at: parse_ts(&updated_at),
    })
}

// -------------------------------------------------------------- sessions ----

pub fn list_sessions(conn: &Connection) -> Result<Vec<Session>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, group_id, name, host, port, username, auth_method,
                    private_key_path, use_keychain, description, color, os_type,
                    last_used_at, created_at, updated_at
               FROM sessions
              ORDER BY name",
        )
        .map_err(db_err("prepare list_sessions"))?;
    let rows = stmt
        .query_map([], row_to_session)
        .map_err(db_err("query list_sessions"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(db_err("collect list_sessions"))
}

pub fn upsert_session(conn: &Connection, input: SessionInput) -> Result<Session, AppError> {
    let now = now_rfc3339();

    if let Some(id) = input.id.clone() {
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM sessions WHERE id = ?1",
                params![&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err("check session existence"))?;

        if exists.is_some() {
            conn.execute(
                "UPDATE sessions
                    SET group_id = ?1,
                        name = ?2,
                        host = ?3,
                        port = ?4,
                        username = ?5,
                        auth_method = ?6,
                        private_key_path = ?7,
                        use_keychain = ?8,
                        description = ?9,
                        color = ?10,
                        updated_at = ?11
                  WHERE id = ?12",
                params![
                    input.group_id,
                    input.name,
                    input.host,
                    input.port as i64,
                    input.username,
                    input.auth_method.as_str(),
                    input.private_key_path,
                    input.use_keychain as i64,
                    input.description,
                    input.color,
                    now,
                    id,
                ],
            )
            .map_err(db_err("update session"))?;
            return fetch_session(conn, &id);
        }
    }

    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    conn.execute(
        "INSERT INTO sessions (
            id, group_id, name, host, port, username, auth_method,
            private_key_path, use_keychain, description, color,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            id,
            input.group_id,
            input.name,
            input.host,
            input.port as i64,
            input.username,
            input.auth_method.as_str(),
            input.private_key_path,
            input.use_keychain as i64,
            input.description,
            input.color,
            now,
        ],
    )
    .map_err(db_err("insert session"))?;
    fetch_session(conn, &id)
}

pub fn fetch_session(conn: &Connection, id: &str) -> Result<Session, AppError> {
    conn.query_row(
        "SELECT id, group_id, name, host, port, username, auth_method,
                private_key_path, use_keychain, description, color, os_type,
                last_used_at, created_at, updated_at
           FROM sessions
          WHERE id = ?1",
        params![id],
        row_to_session,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("session {id}")),
        other => AppError::Database(format!("fetch session: {other}")),
    })
}

pub fn delete_session(conn: &Connection, id: &str) -> Result<(), AppError> {
    let rows = conn
        .execute("DELETE FROM sessions WHERE id = ?1", params![id])
        .map_err(db_err("delete session"))?;
    if rows == 0 {
        return Err(AppError::NotFound(format!("session {id}")));
    }
    Ok(())
}

/// Remove duplicate sessions keeping only the oldest (by created_at) for each
/// unique (host, port, username) triple.
pub fn dedup_sessions(conn: &Connection) -> Result<u64, AppError> {
    let deleted = conn
        .execute(
            "DELETE FROM sessions WHERE id NOT IN (
                SELECT MIN(id) FROM sessions GROUP BY host, port, username
             )",
            [],
        )
        .map_err(db_err("dedup sessions"))?;
    Ok(deleted as u64)
}

/// Partially update auth fields — used when prompted credentials succeed.
pub fn patch_session_auth(
    conn: &Connection,
    id: &str,
    auth_method: Option<super::AuthMethod>,
    username: Option<&str>,
) -> Result<(), AppError> {
    let now = now_rfc3339();
    if let Some(am) = auth_method {
        conn.execute(
            "UPDATE sessions SET auth_method = ?1, updated_at = ?2 WHERE id = ?3",
            params![am.as_str(), now, id],
        )
        .map_err(db_err("patch auth_method"))?;
    }
    if let Some(user) = username {
        conn.execute(
            "UPDATE sessions SET username = ?1, updated_at = ?2 WHERE id = ?3",
            params![user, now, id],
        )
        .map_err(db_err("patch username"))?;
    }
    Ok(())
}

/// Store the auto-detected OS family string (opaque lowercase token).
/// No-op if the value matches the current one to avoid churning `updated_at`.
pub fn patch_session_os(conn: &Connection, id: &str, os_type: &str) -> Result<(), AppError> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT os_type FROM sessions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err("read os_type"))?
        .flatten();

    if existing.as_deref() == Some(os_type) {
        return Ok(());
    }

    let now = now_rfc3339();
    let rows = conn
        .execute(
            "UPDATE sessions SET os_type = ?1, updated_at = ?2 WHERE id = ?3",
            params![os_type, now, id],
        )
        .map_err(db_err("patch os_type"))?;
    if rows == 0 {
        return Err(AppError::NotFound(format!("session {id}")));
    }
    Ok(())
}

/// Bumps `last_used_at` — called from `commands::ssh::ssh_test_connect`
/// after a successful probe (step 5+).
pub fn touch_session(conn: &Connection, id: &str) -> Result<(), AppError> {
    let now = now_rfc3339();
    let rows = conn
        .execute(
            "UPDATE sessions SET last_used_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )
        .map_err(db_err("touch session"))?;
    if rows == 0 {
        return Err(AppError::NotFound(format!("session {id}")));
    }
    Ok(())
}

fn row_to_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    let auth_str: String = row.get("auth_method")?;
    let auth_method = AuthMethod::parse(&auth_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("invalid auth_method {auth_str}").into(),
        )
    })?;

    let port: i64 = row.get("port")?;
    let port = u16::try_from(port).unwrap_or(22);

    let use_keychain: i64 = row.get("use_keychain")?;
    let created_at: String = row.get("created_at")?;
    let updated_at: String = row.get("updated_at")?;
    let last_used_at: Option<String> = row.get("last_used_at")?;

    Ok(Session {
        id: row.get("id")?,
        group_id: row.get("group_id")?,
        name: row.get("name")?,
        host: row.get("host")?,
        port,
        username: row.get("username")?,
        auth_method,
        private_key_path: row.get("private_key_path")?,
        use_keychain: use_keychain != 0,
        description: row.get("description")?,
        color: row.get("color")?,
        os_type: row.get("os_type")?,
        last_used_at: last_used_at.as_deref().map(parse_ts),
        created_at: parse_ts(&created_at),
        updated_at: parse_ts(&updated_at),
    })
}

// --------------------------------------------------------- port forwards ----

pub fn list_port_forwards(conn: &Connection, session_id: &str) -> Result<Vec<PortForward>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, forward_type, label,
                    bind_host, bind_port, target_host, target_port,
                    enabled, created_at, updated_at
               FROM port_forwards
              WHERE session_id = ?1
              ORDER BY created_at",
        )
        .map_err(db_err("prepare list_port_forwards"))?;
    let rows = stmt
        .query_map(params![session_id], row_to_port_forward)
        .map_err(db_err("query list_port_forwards"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(db_err("collect list_port_forwards"))
}

pub fn upsert_port_forward(conn: &Connection, input: PortForwardInput) -> Result<PortForward, AppError> {
    let now = now_rfc3339();

    if let Some(id) = input.id.clone() {
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM port_forwards WHERE id = ?1",
                params![&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err("check port_forward existence"))?;

        if exists.is_some() {
            conn.execute(
                "UPDATE port_forwards
                    SET session_id = ?1,
                        forward_type = ?2,
                        label = ?3,
                        bind_host = ?4,
                        bind_port = ?5,
                        target_host = ?6,
                        target_port = ?7,
                        enabled = ?8,
                        updated_at = ?9
                  WHERE id = ?10",
                params![
                    input.session_id,
                    input.forward_type.as_str(),
                    input.label,
                    input.bind_host.unwrap_or_else(|| "127.0.0.1".into()),
                    input.bind_port as i64,
                    input.target_host.unwrap_or_else(|| "127.0.0.1".into()),
                    input.target_port as i64,
                    input.enabled.unwrap_or(true) as i64,
                    now,
                    id,
                ],
            )
            .map_err(db_err("update port_forward"))?;
            return fetch_port_forward(conn, &id);
        }
    }

    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    conn.execute(
        "INSERT INTO port_forwards (
            id, session_id, forward_type, label,
            bind_host, bind_port, target_host, target_port,
            enabled, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            input.session_id,
            input.forward_type.as_str(),
            input.label,
            input.bind_host.unwrap_or_else(|| "127.0.0.1".into()),
            input.bind_port as i64,
            input.target_host.unwrap_or_else(|| "127.0.0.1".into()),
            input.target_port as i64,
            input.enabled.unwrap_or(true) as i64,
            now,
        ],
    )
    .map_err(db_err("insert port_forward"))?;
    fetch_port_forward(conn, &id)
}

pub fn fetch_port_forward(conn: &Connection, id: &str) -> Result<PortForward, AppError> {
    conn.query_row(
        "SELECT id, session_id, forward_type, label,
                bind_host, bind_port, target_host, target_port,
                enabled, created_at, updated_at
           FROM port_forwards
          WHERE id = ?1",
        params![id],
        row_to_port_forward,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("port_forward {id}")),
        other => AppError::Database(format!("fetch port_forward: {other}")),
    })
}

pub fn delete_port_forward(conn: &Connection, id: &str) -> Result<(), AppError> {
    let rows = conn
        .execute("DELETE FROM port_forwards WHERE id = ?1", params![id])
        .map_err(db_err("delete port_forward"))?;
    if rows == 0 {
        return Err(AppError::NotFound(format!("port_forward {id}")));
    }
    Ok(())
}

fn row_to_port_forward(row: &Row<'_>) -> rusqlite::Result<PortForward> {
    let ft_str: String = row.get("forward_type")?;
    let forward_type = PortForwardType::parse(&ft_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("invalid forward_type {ft_str}").into(),
        )
    })?;

    let bind_port: i64 = row.get("bind_port")?;
    let target_port: i64 = row.get("target_port")?;
    let enabled: i64 = row.get("enabled")?;
    let created_at: String = row.get("created_at")?;
    let updated_at: String = row.get("updated_at")?;

    Ok(PortForward {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        forward_type,
        label: row.get("label")?,
        bind_host: row.get("bind_host")?,
        bind_port: u16::try_from(bind_port).unwrap_or(0),
        target_host: row.get("target_host")?,
        target_port: u16::try_from(target_port).unwrap_or(0),
        enabled: enabled != 0,
        created_at: parse_ts(&created_at),
        updated_at: parse_ts(&updated_at),
    })
}
