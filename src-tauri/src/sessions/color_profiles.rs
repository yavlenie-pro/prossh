//! CRUD for color profiles in the `color_profiles` table.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

fn db_err<E: std::fmt::Display>(op: &'static str) -> impl FnOnce(E) -> AppError {
    move |e| AppError::Database(format!("{op}: {e}"))
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn parse_ts(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

/// A color profile stored in the database.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorProfile {
    pub id: String,
    pub name: String,
    pub is_builtin: bool,
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Input for creating/updating a custom color profile.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorProfileInput {
    pub id: Option<String>,
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
}

pub fn list(conn: &Connection) -> Result<Vec<ColorProfile>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, is_builtin,
                    foreground, background, cursor, selection,
                    black, red, green, yellow, blue, magenta, cyan, white,
                    bright_black, bright_red, bright_green, bright_yellow,
                    bright_blue, bright_magenta, bright_cyan, bright_white,
                    created_at, updated_at
             FROM color_profiles
             ORDER BY is_builtin DESC, name",
        )
        .map_err(db_err("prepare list_color_profiles"))?;
    let rows = stmt
        .query_map([], row_to_profile)
        .map_err(db_err("query list_color_profiles"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(db_err("collect list_color_profiles"))
}

pub fn upsert(conn: &Connection, input: ColorProfileInput) -> Result<ColorProfile, AppError> {
    let now = now_rfc3339();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());

    conn.execute(
        "INSERT INTO color_profiles (
            id, name, is_builtin,
            foreground, background, cursor, selection,
            black, red, green, yellow, blue, magenta, cyan, white,
            bright_black, bright_red, bright_green, bright_yellow,
            bright_blue, bright_magenta, bright_cyan, bright_white,
            created_at, updated_at
        ) VALUES (
            ?1,?2,0,
            ?3,?4,?5,?6,
            ?7,?8,?9,?10,?11,?12,?13,?14,
            ?15,?16,?17,?18,?19,?20,?21,?22,
            ?23,?23
        ) ON CONFLICT(id) DO UPDATE SET
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
            updated_at=excluded.updated_at",
        params![
            id, input.name,
            input.foreground, input.background, input.cursor, input.selection,
            input.black, input.red, input.green, input.yellow,
            input.blue, input.magenta, input.cyan, input.white,
            input.bright_black, input.bright_red, input.bright_green, input.bright_yellow,
            input.bright_blue, input.bright_magenta, input.bright_cyan, input.bright_white,
            now,
        ],
    )
    .map_err(db_err("upsert color_profile"))?;

    fetch(conn, &id)
}

pub fn fetch(conn: &Connection, id: &str) -> Result<ColorProfile, AppError> {
    conn.query_row(
        "SELECT id, name, is_builtin,
                foreground, background, cursor, selection,
                black, red, green, yellow, blue, magenta, cyan, white,
                bright_black, bright_red, bright_green, bright_yellow,
                bright_blue, bright_magenta, bright_cyan, bright_white,
                created_at, updated_at
         FROM color_profiles WHERE id = ?1",
        params![id],
        row_to_profile,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            AppError::NotFound(format!("color profile {id}"))
        }
        other => AppError::Database(format!("fetch color_profile: {other}")),
    })
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), AppError> {
    // Prevent deleting built-in profiles
    let is_builtin: Option<i64> = conn
        .query_row(
            "SELECT is_builtin FROM color_profiles WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err("check color_profile"))?;

    match is_builtin {
        None => return Err(AppError::NotFound(format!("color profile {id}"))),
        Some(1) => {
            return Err(AppError::InvalidArgument(
                "cannot delete built-in color profile".into(),
            ))
        }
        _ => {}
    }

    conn.execute("DELETE FROM color_profiles WHERE id = ?1", params![id])
        .map_err(db_err("delete color_profile"))?;
    Ok(())
}

fn row_to_profile(row: &Row<'_>) -> rusqlite::Result<ColorProfile> {
    let is_builtin: i64 = row.get("is_builtin")?;
    let created_at: String = row.get("created_at")?;
    let updated_at: String = row.get("updated_at")?;

    Ok(ColorProfile {
        id: row.get("id")?,
        name: row.get("name")?,
        is_builtin: is_builtin != 0,
        foreground: row.get("foreground")?,
        background: row.get("background")?,
        cursor: row.get("cursor")?,
        selection: row.get("selection")?,
        black: row.get("black")?,
        red: row.get("red")?,
        green: row.get("green")?,
        yellow: row.get("yellow")?,
        blue: row.get("blue")?,
        magenta: row.get("magenta")?,
        cyan: row.get("cyan")?,
        white: row.get("white")?,
        bright_black: row.get("bright_black")?,
        bright_red: row.get("bright_red")?,
        bright_green: row.get("bright_green")?,
        bright_yellow: row.get("bright_yellow")?,
        bright_blue: row.get("bright_blue")?,
        bright_magenta: row.get("bright_magenta")?,
        bright_cyan: row.get("bright_cyan")?,
        bright_white: row.get("bright_white")?,
        created_at: parse_ts(&created_at),
        updated_at: parse_ts(&updated_at),
    })
}
