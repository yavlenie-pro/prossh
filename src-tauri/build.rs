//! Build script — runs tauri-build and bakes the display version into the
//! binary via the `PROSSH_VERSION` compile-time env var.
//!
//! Resolution order:
//!   1. `PROSSH_BUILD_VERSION` from the environment (set by CI) — used verbatim.
//!   2. `CARGO_PKG_VERSION` from `Cargo.toml`, optionally suffixed with
//!      `+sha.<shortSHA>` when the build happens inside a git checkout.
//!
//! The value is exposed to Rust code as `env!("PROSSH_VERSION")`.

use std::process::Command;

fn main() {
    // Re-run whenever the override or git HEAD changes.
    println!("cargo:rerun-if-env-changed=PROSSH_BUILD_VERSION");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");

    let version = resolve_version();
    println!("cargo:rustc-env=PROSSH_VERSION={version}");

    tauri_build::build();
}

fn resolve_version() -> String {
    // 1. CI override wins outright.
    if let Ok(v) = std::env::var("PROSSH_BUILD_VERSION") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    // 2. Cargo.toml version (+ short git SHA if we can get one).
    let base = env!("CARGO_PKG_VERSION");
    match short_git_sha() {
        Some(sha) => format!("{base}+sha.{sha}"),
        None => base.to_string(),
    }
}

fn short_git_sha() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}
