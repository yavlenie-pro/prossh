//! Schema migrations. Version is stored in SQLite's built-in
//! `PRAGMA user_version` so we don't need a bookkeeping table.
//!
//! Adding a new migration:
//!   1. Bump [`CURRENT_VERSION`].
//!   2. Add a new `apply_vN` function with the schema changes.
//!   3. Route it in the `match` inside [`apply`].

use rusqlite::Connection;

use crate::error::AppError;

/// Bump this whenever a new `apply_vN` is added.
const CURRENT_VERSION: i32 = 5;

pub fn apply(conn: &Connection) -> Result<(), AppError> {
    let mut version = read_version(conn)?;

    if version >= CURRENT_VERSION {
        tracing::debug!(version, "database schema up to date");
        return Ok(());
    }

    while version < CURRENT_VERSION {
        let next = version + 1;
        tracing::info!(from = version, to = next, "applying migration");
        match next {
            1 => apply_v1(conn)?,
            2 => apply_v2(conn)?,
            3 => apply_v3(conn)?,
            4 => apply_v4(conn)?,
            5 => apply_v5(conn)?,
            n => return Err(AppError::Database(format!("unknown migration target {n}"))),
        }
        write_version(conn, next)?;
        version = next;
    }

    Ok(())
}

fn read_version(conn: &Connection) -> Result<i32, AppError> {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0))
        .map_err(|e| AppError::Database(format!("read user_version: {e}")))
}

fn write_version(conn: &Connection, v: i32) -> Result<(), AppError> {
    // PRAGMA doesn't allow parameter binding, but `v` is a local i32 we control.
    conn.execute_batch(&format!("PRAGMA user_version = {v}"))
        .map_err(|e| AppError::Database(format!("write user_version: {e}")))
}

// -----------------------------------------------------------------------------
// v1 — initial schema: groups + sessions
// -----------------------------------------------------------------------------

fn apply_v1(conn: &Connection) -> Result<(), AppError> {
    const SQL: &str = r#"
        CREATE TABLE IF NOT EXISTS groups (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            parent_id   TEXT REFERENCES groups(id) ON DELETE CASCADE,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent_id);

        CREATE TABLE IF NOT EXISTS sessions (
            id                TEXT PRIMARY KEY,
            group_id          TEXT REFERENCES groups(id) ON DELETE SET NULL,
            name              TEXT NOT NULL,
            host              TEXT NOT NULL,
            port              INTEGER NOT NULL DEFAULT 22,
            username          TEXT NOT NULL,
            auth_method       TEXT NOT NULL
                              CHECK(auth_method IN ('password','key','agent')),
            private_key_path  TEXT,
            use_keychain      INTEGER NOT NULL DEFAULT 0,
            description       TEXT,
            color             TEXT,
            last_used_at      TEXT,
            created_at        TEXT NOT NULL,
            updated_at        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_group      ON sessions(group_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_last_used  ON sessions(last_used_at DESC);
    "#;

    conn.execute_batch(SQL)
        .map_err(|e| AppError::Database(format!("apply v1: {e}")))?;
    Ok(())
}

// -----------------------------------------------------------------------------
// v2 — color profiles + settings KV
// -----------------------------------------------------------------------------

fn apply_v2(conn: &Connection) -> Result<(), AppError> {
    const SQL: &str = r#"
        CREATE TABLE IF NOT EXISTS color_profiles (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            is_builtin  INTEGER NOT NULL DEFAULT 0,
            foreground  TEXT NOT NULL,
            background  TEXT NOT NULL,
            cursor      TEXT NOT NULL,
            selection   TEXT NOT NULL,
            black       TEXT NOT NULL,
            red         TEXT NOT NULL,
            green       TEXT NOT NULL,
            yellow      TEXT NOT NULL,
            blue        TEXT NOT NULL,
            magenta     TEXT NOT NULL,
            cyan        TEXT NOT NULL,
            white       TEXT NOT NULL,
            bright_black   TEXT NOT NULL,
            bright_red     TEXT NOT NULL,
            bright_green   TEXT NOT NULL,
            bright_yellow  TEXT NOT NULL,
            bright_blue    TEXT NOT NULL,
            bright_magenta TEXT NOT NULL,
            bright_cyan    TEXT NOT NULL,
            bright_white   TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    "#;

    conn.execute_batch(SQL)
        .map_err(|e| AppError::Database(format!("apply v2: {e}")))?;

    // Seed built-in color profiles
    seed_builtin_profiles(conn)?;

    Ok(())
}

fn seed_builtin_profiles(conn: &Connection) -> Result<(), AppError> {
    use crate::themes::BUILTIN_PROFILES;
    let now = chrono::Utc::now().to_rfc3339();

    for p in BUILTIN_PROFILES {
        conn.execute(
            "INSERT OR IGNORE INTO color_profiles (
                id, name, is_builtin,
                foreground, background, cursor, selection,
                black, red, green, yellow, blue, magenta, cyan, white,
                bright_black, bright_red, bright_green, bright_yellow,
                bright_blue, bright_magenta, bright_cyan, bright_white,
                created_at, updated_at
            ) VALUES (
                ?1,?2,1,
                ?3,?4,?5,?6,
                ?7,?8,?9,?10,?11,?12,?13,?14,
                ?15,?16,?17,?18,?19,?20,?21,?22,
                ?23,?23
            )",
            rusqlite::params![
                p.id, p.name,
                p.foreground, p.background, p.cursor, p.selection,
                p.black, p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan, p.white,
                p.bright_black, p.bright_red, p.bright_green, p.bright_yellow,
                p.bright_blue, p.bright_magenta, p.bright_cyan, p.bright_white,
                now,
            ],
        ).map_err(|e| AppError::Database(format!("seed profile {}: {e}", p.id)))?;
    }

    Ok(())
}

// -----------------------------------------------------------------------------
// v3 — scripts (global + per-session)
// -----------------------------------------------------------------------------

fn apply_v3(conn: &Connection) -> Result<(), AppError> {
    const SQL: &str = r#"
        CREATE TABLE IF NOT EXISTS scripts (
            id          TEXT PRIMARY KEY,
            session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            command     TEXT NOT NULL,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scripts_session ON scripts(session_id);
    "#;

    conn.execute_batch(SQL)
        .map_err(|e| AppError::Database(format!("apply v3: {e}")))?;
    Ok(())
}

// -----------------------------------------------------------------------------
// v4 — port forwards (local / remote per session)
// -----------------------------------------------------------------------------

fn apply_v4(conn: &Connection) -> Result<(), AppError> {
    const SQL: &str = r#"
        CREATE TABLE IF NOT EXISTS port_forwards (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            forward_type TEXT NOT NULL CHECK(forward_type IN ('local','remote')),
            label       TEXT,
            bind_host   TEXT NOT NULL DEFAULT '127.0.0.1',
            bind_port   INTEGER NOT NULL,
            target_host TEXT NOT NULL DEFAULT '127.0.0.1',
            target_port INTEGER NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_port_forwards_session ON port_forwards(session_id);
    "#;

    conn.execute_batch(SQL)
        .map_err(|e| AppError::Database(format!("apply v4: {e}")))?;
    Ok(())
}

// -----------------------------------------------------------------------------
// v5 — auto-detected OS type per session (`uname -s` / Windows `ver`)
// -----------------------------------------------------------------------------

fn apply_v5(conn: &Connection) -> Result<(), AppError> {
    const SQL: &str = r#"
        ALTER TABLE sessions ADD COLUMN os_type TEXT;
    "#;

    conn.execute_batch(SQL)
        .map_err(|e| AppError::Database(format!("apply v5: {e}")))?;
    Ok(())
}
