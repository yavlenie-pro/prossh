//! Miscellaneous commands used during scaffolding to verify the IPC pipe.

use crate::error::AppError;

/// Round-trip sanity check — frontend can call this on boot to confirm the
/// backend is alive and responsive.
#[tauri::command]
pub async fn ping() -> Result<&'static str, AppError> {
    Ok("pong")
}

/// Returns the display version baked into the binary at build time.
///
/// The value is produced by `build.rs`: it's `PROSSH_BUILD_VERSION` from the
/// environment when set (CI), or `CARGO_PKG_VERSION` + `+sha.<shortSHA>` from
/// git for local dev builds.
#[tauri::command]
pub async fn app_version() -> Result<&'static str, AppError> {
    Ok(env!("PROSSH_VERSION"))
}
