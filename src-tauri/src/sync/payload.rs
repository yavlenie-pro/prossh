//! Snapshot assembly: turn the local database + secrets into a self-contained
//! JSON payload that we can encrypt and push to Drive, and the reverse
//! operation on pull.
//!
//! ## What gets included
//!
//! - **groups** — session folders
//! - **sessions** — connection metadata
//! - **port_forwards** — tunnel definitions attached to sessions
//! - **color_profiles** — only user-defined; built-ins are seeded on every
//!   install so shipping them over the wire is pure duplication
//! - **scripts** — global + per-session user scripts
//! - **secrets** — passwords / passphrases keyed by `session::<id>` so they
//!   line up with the `sessions` entries exactly
//!
//! ## What is deliberately *not* included
//!
//! - **known_hosts** — host key TOFU state is per-machine; importing someone
//!   else's file would defeat the whole point of TOFU
//! - **sync config** — client_id/client_secret/filename are stored in
//!   settings; we must not round-trip them through a snapshot
//! - **last_used_at** / opened tabs / UI state — ephemeral
//!
//! ## Merge strategy on pull
//!
//! Row-level last-write-wins keyed by primary id:
//!
//! - New id → insert.
//! - Existing id with `excluded.updated_at >= local.updated_at` → overwrite.
//! - Existing id with an older remote → keep the local row untouched.
//!
//! That handles the "two devices edit the same session" case without a
//! vector clock: whoever saved last wins, symmetrically on both devices.
//! Entities that exist locally but not in the snapshot are left alone; we
//! don't try to detect deletions because without tombstones you can't tell
//! "deleted there" from "created here".
//!
//! `created_at` is INSERT-only — once a row exists locally we never touch
//! its birth date, even when a merge overwrites everything else.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::secrets;

/// Bump if the on-the-wire schema changes incompatibly. Older clients
/// refuse to apply snapshots with a version they don't understand.
const PAYLOAD_VERSION: u32 = 1;

/// Top-level snapshot. Every field defaults to empty on deserialization so a
/// future push that adds a new section doesn't crash older readers (they'll
/// just ignore the part they don't know about — within reason).
#[derive(Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    #[serde(default)]
    pub exported_at: String,
    #[serde(default)]
    pub groups: Vec<GroupRow>,
    #[serde(default)]
    pub sessions: Vec<SessionRow>,
    #[serde(default)]
    pub port_forwards: Vec<PortForwardRow>,
    #[serde(default)]
    pub color_profiles: Vec<ColorProfileRow>,
    #[serde(default)]
    pub scripts: Vec<ScriptRow>,
    /// Flat list rather than a map so the on-disk JSON is easy to diff in
    /// debug tooling. Each entry's `key` is `session::<id>`.
    #[serde(default)]
    pub secrets: Vec<SecretRow>,
}

// ---- row types ----
//
// We deliberately use plain-Vec<String/Option<String>> types here rather
// than reusing the UI-facing models from `sessions::*`. Reasons:
//
// - Those models parse/validate timestamps and enums into Rust types; a
//   remote snapshot should round-trip *bytes* verbatim so a value from a
//   newer client that we don't fully understand yet doesn't get silently
//   re-encoded.
// - These rows map 1:1 to SQL columns, so `fill_from_db` / `apply_to_db`
//   are trivial column loops.

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_method: String,
    pub private_key_path: Option<String>,
    pub use_keychain: i64,
    pub description: Option<String>,
    pub color: Option<String>,
    pub os_type: Option<String>,
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRow {
    pub id: String,
    pub session_id: String,
    pub forward_type: String,
    pub label: Option<String>,
    pub bind_host: String,
    pub bind_port: i64,
    pub target_host: String,
    pub target_port: i64,
    pub enabled: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorProfileRow {
    pub id: String,
    pub name: String,
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    pub selection: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRow {
    pub id: String,
    pub session_id: Option<String>,
    pub name: String,
    pub command: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SecretRow {
    pub key: String,
    pub value: String,
}

/// Outcome returned to the frontend after a successful pull — helps the UI
/// say "imported 3 sessions, 1 color profile" instead of just "ok".
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyStats {
    pub groups: u32,
    pub sessions: u32,
    pub port_forwards: u32,
    pub color_profiles: u32,
    pub scripts: u32,
    pub secrets: u32,
}

// ---- build from local state ----

/// Gather everything into a [`Snapshot`]. The caller wraps this in
/// `spawn_blocking` — DB calls are sync and secrets::get can be slow for the
/// file backend.
pub fn build(conn: &Connection) -> Result<Snapshot, AppError> {
    let groups = collect_groups(conn)?;
    let sessions = collect_sessions(conn)?;
    let port_forwards = collect_port_forwards(conn)?;
    let color_profiles = collect_color_profiles(conn)?;
    let scripts = collect_scripts(conn)?;
    // Collect secrets only for sessions we're actually exporting — no point
    // shipping orphaned keyring entries.
    let secrets = collect_secrets(&sessions)?;

    Ok(Snapshot {
        version: PAYLOAD_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        groups,
        sessions,
        port_forwards,
        color_profiles,
        scripts,
        secrets,
    })
}

fn collect_groups(conn: &Connection) -> Result<Vec<GroupRow>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, parent_id, sort_order, created_at, updated_at FROM groups",
        )
        .map_err(|e| AppError::Database(format!("prepare groups: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(GroupRow {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                sort_order: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })
        .map_err(|e| AppError::Database(format!("query groups: {e}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Database(format!("collect groups: {e}")))
}

fn collect_sessions(conn: &Connection) -> Result<Vec<SessionRow>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, group_id, name, host, port, username, auth_method,
                    private_key_path, use_keychain, description, color, os_type,
                    last_used_at, created_at, updated_at
             FROM sessions",
        )
        .map_err(|e| AppError::Database(format!("prepare sessions: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                group_id: r.get(1)?,
                name: r.get(2)?,
                host: r.get(3)?,
                port: r.get(4)?,
                username: r.get(5)?,
                auth_method: r.get(6)?,
                private_key_path: r.get(7)?,
                use_keychain: r.get(8)?,
                description: r.get(9)?,
                color: r.get(10)?,
                os_type: r.get(11)?,
                last_used_at: r.get(12)?,
                created_at: r.get(13)?,
                updated_at: r.get(14)?,
            })
        })
        .map_err(|e| AppError::Database(format!("query sessions: {e}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Database(format!("collect sessions: {e}")))
}

fn collect_port_forwards(conn: &Connection) -> Result<Vec<PortForwardRow>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, forward_type, label, bind_host, bind_port,
                    target_host, target_port, enabled, created_at, updated_at
             FROM port_forwards",
        )
        .map_err(|e| AppError::Database(format!("prepare port_forwards: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PortForwardRow {
                id: r.get(0)?,
                session_id: r.get(1)?,
                forward_type: r.get(2)?,
                label: r.get(3)?,
                bind_host: r.get(4)?,
                bind_port: r.get(5)?,
                target_host: r.get(6)?,
                target_port: r.get(7)?,
                enabled: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })
        .map_err(|e| AppError::Database(format!("query port_forwards: {e}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Database(format!("collect port_forwards: {e}")))
}

fn collect_color_profiles(conn: &Connection) -> Result<Vec<ColorProfileRow>, AppError> {
    // Skip built-ins — every install seeds the same set, we'd just be
    // uploading churn (and risk overwriting a future built-in with an old
    // user-renamed copy).
    let mut stmt = conn
        .prepare(
            "SELECT id, name,
                    foreground, background, cursor, selection,
                    black, red, green, yellow, blue, magenta, cyan, white,
                    bright_black, bright_red, bright_green, bright_yellow,
                    bright_blue, bright_magenta, bright_cyan, bright_white,
                    created_at, updated_at
             FROM color_profiles
             WHERE is_builtin = 0",
        )
        .map_err(|e| AppError::Database(format!("prepare color_profiles: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ColorProfileRow {
                id: r.get(0)?,
                name: r.get(1)?,
                foreground: r.get(2)?,
                background: r.get(3)?,
                cursor: r.get(4)?,
                selection: r.get(5)?,
                black: r.get(6)?,
                red: r.get(7)?,
                green: r.get(8)?,
                yellow: r.get(9)?,
                blue: r.get(10)?,
                magenta: r.get(11)?,
                cyan: r.get(12)?,
                white: r.get(13)?,
                bright_black: r.get(14)?,
                bright_red: r.get(15)?,
                bright_green: r.get(16)?,
                bright_yellow: r.get(17)?,
                bright_blue: r.get(18)?,
                bright_magenta: r.get(19)?,
                bright_cyan: r.get(20)?,
                bright_white: r.get(21)?,
                created_at: r.get(22)?,
                updated_at: r.get(23)?,
            })
        })
        .map_err(|e| AppError::Database(format!("query color_profiles: {e}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Database(format!("collect color_profiles: {e}")))
}

fn collect_scripts(conn: &Connection) -> Result<Vec<ScriptRow>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, name, command, sort_order, created_at, updated_at
             FROM scripts",
        )
        .map_err(|e| AppError::Database(format!("prepare scripts: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ScriptRow {
                id: r.get(0)?,
                session_id: r.get(1)?,
                name: r.get(2)?,
                command: r.get(3)?,
                sort_order: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })
        .map_err(|e| AppError::Database(format!("query scripts: {e}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Database(format!("collect scripts: {e}")))
}

fn collect_secrets(sessions: &[SessionRow]) -> Result<Vec<SecretRow>, AppError> {
    let mut out = Vec::new();
    for s in sessions {
        let key = crate::sessions::secret_key(&s.id);
        if let Some(value) = secrets::get(&key)? {
            out.push(SecretRow { key, value });
        }
    }
    Ok(out)
}

// ---- apply remote snapshot ----

/// Apply a [`Snapshot`] to the local database + secret store. Runs inside a
/// single SQL transaction so a mid-apply failure leaves the local DB
/// unchanged; secrets are written afterwards because they live outside the
/// transaction anyway.
pub fn apply(conn: &mut Connection, snap: Snapshot) -> Result<ApplyStats, AppError> {
    if snap.version > PAYLOAD_VERSION {
        return Err(AppError::InvalidArgument(format!(
            "this build can't read sync payload v{} — please update ProSSH",
            snap.version,
        )));
    }

    let mut stats = ApplyStats::default();

    let tx = conn
        .transaction()
        .map_err(|e| AppError::Database(format!("begin apply tx: {e}")))?;

    // Groups first — sessions FK them; port_forwards & secrets FK sessions.
    //
    // Every `ON CONFLICT DO UPDATE` is gated on
    // `excluded.updated_at >= <table>.updated_at` so an older remote row
    // can't clobber fresher local edits. Timestamps are RFC3339 strings —
    // lexicographic comparison matches chronological order as long as all
    // writers produce the same format (they do, `chrono::Utc::now().to_rfc3339()`).
    //
    // `tx.execute` returns the number of rows the statement actually
    // touched: 1 for a fresh insert, 1 for an UPDATE that ran, and 0 when
    // the conflict was resolved by the WHERE clause (remote was older).
    // We accumulate that into `stats` so the "merged N rows" toast reflects
    // real changes, not just payload size.
    for g in &snap.groups {
        let n = tx.execute(
            "INSERT INTO groups (id, name, parent_id, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name,
                 parent_id=excluded.parent_id,
                 sort_order=excluded.sort_order,
                 updated_at=excluded.updated_at
             WHERE excluded.updated_at >= groups.updated_at",
            params![g.id, g.name, g.parent_id, g.sort_order, g.created_at, g.updated_at],
        )
        .map_err(|e| AppError::Database(format!("apply group {}: {e}", g.id)))?;
        stats.groups += n as u32;
    }

    for s in &snap.sessions {
        let n = tx.execute(
            "INSERT INTO sessions (
                id, group_id, name, host, port, username, auth_method,
                private_key_path, use_keychain, description, color, os_type,
                last_used_at, created_at, updated_at
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7,
                 ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15
             )
             ON CONFLICT(id) DO UPDATE SET
                 group_id=excluded.group_id,
                 name=excluded.name,
                 host=excluded.host,
                 port=excluded.port,
                 username=excluded.username,
                 auth_method=excluded.auth_method,
                 private_key_path=excluded.private_key_path,
                 use_keychain=excluded.use_keychain,
                 description=excluded.description,
                 color=excluded.color,
                 os_type=excluded.os_type,
                 last_used_at=excluded.last_used_at,
                 updated_at=excluded.updated_at
             WHERE excluded.updated_at >= sessions.updated_at",
            params![
                s.id, s.group_id, s.name, s.host, s.port, s.username, s.auth_method,
                s.private_key_path, s.use_keychain, s.description, s.color, s.os_type,
                s.last_used_at, s.created_at, s.updated_at,
            ],
        )
        .map_err(|e| AppError::Database(format!("apply session {}: {e}", s.id)))?;
        stats.sessions += n as u32;
    }

    for pf in &snap.port_forwards {
        let n = tx.execute(
            "INSERT INTO port_forwards (
                id, session_id, forward_type, label,
                bind_host, bind_port, target_host, target_port,
                enabled, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                 session_id=excluded.session_id,
                 forward_type=excluded.forward_type,
                 label=excluded.label,
                 bind_host=excluded.bind_host,
                 bind_port=excluded.bind_port,
                 target_host=excluded.target_host,
                 target_port=excluded.target_port,
                 enabled=excluded.enabled,
                 updated_at=excluded.updated_at
             WHERE excluded.updated_at >= port_forwards.updated_at",
            params![
                pf.id, pf.session_id, pf.forward_type, pf.label,
                pf.bind_host, pf.bind_port, pf.target_host, pf.target_port,
                pf.enabled, pf.created_at, pf.updated_at,
            ],
        )
        .map_err(|e| AppError::Database(format!("apply port_forward {}: {e}", pf.id)))?;
        stats.port_forwards += n as u32;
    }

    for cp in &snap.color_profiles {
        let n = tx.execute(
            "INSERT INTO color_profiles (
                id, name, is_builtin,
                foreground, background, cursor, selection,
                black, red, green, yellow, blue, magenta, cyan, white,
                bright_black, bright_red, bright_green, bright_yellow,
                bright_blue, bright_magenta, bright_cyan, bright_white,
                created_at, updated_at
             ) VALUES (
                 ?1, ?2, 0,
                 ?3, ?4, ?5, ?6,
                 ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
                 ?23, ?24
             )
             ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name,
                 foreground=excluded.foreground, background=excluded.background,
                 cursor=excluded.cursor, selection=excluded.selection,
                 black=excluded.black, red=excluded.red, green=excluded.green,
                 yellow=excluded.yellow, blue=excluded.blue, magenta=excluded.magenta,
                 cyan=excluded.cyan, white=excluded.white,
                 bright_black=excluded.bright_black, bright_red=excluded.bright_red,
                 bright_green=excluded.bright_green, bright_yellow=excluded.bright_yellow,
                 bright_blue=excluded.bright_blue, bright_magenta=excluded.bright_magenta,
                 bright_cyan=excluded.bright_cyan, bright_white=excluded.bright_white,
                 updated_at=excluded.updated_at
             WHERE excluded.updated_at >= color_profiles.updated_at",
            params![
                cp.id, cp.name,
                cp.foreground, cp.background, cp.cursor, cp.selection,
                cp.black, cp.red, cp.green, cp.yellow, cp.blue, cp.magenta, cp.cyan, cp.white,
                cp.bright_black, cp.bright_red, cp.bright_green, cp.bright_yellow,
                cp.bright_blue, cp.bright_magenta, cp.bright_cyan, cp.bright_white,
                cp.created_at, cp.updated_at,
            ],
        )
        .map_err(|e| AppError::Database(format!("apply color_profile {}: {e}", cp.id)))?;
        stats.color_profiles += n as u32;
    }

    for sc in &snap.scripts {
        let n = tx.execute(
            "INSERT INTO scripts (id, session_id, name, command, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 session_id=excluded.session_id,
                 name=excluded.name,
                 command=excluded.command,
                 sort_order=excluded.sort_order,
                 updated_at=excluded.updated_at
             WHERE excluded.updated_at >= scripts.updated_at",
            params![
                sc.id, sc.session_id, sc.name, sc.command, sc.sort_order,
                sc.created_at, sc.updated_at,
            ],
        )
        .map_err(|e| AppError::Database(format!("apply script {}: {e}", sc.id)))?;
        stats.scripts += n as u32;
    }

    tx.commit()
        .map_err(|e| AppError::Database(format!("commit apply: {e}")))?;

    // Secrets live outside the SQL transaction — write them after we're
    // confident the DB rows are persisted. A partial failure here leaves
    // sessions with no stored secret, which degrades to a password prompt
    // rather than breaking the session entirely.
    for entry in &snap.secrets {
        secrets::set(&entry.key, &entry.value)?;
        stats.secrets += 1;
    }

    Ok(stats)
}
