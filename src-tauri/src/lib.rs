//! prossh — cross-platform SSH/SCP client backend.
//!
//! This crate exposes a single entry point [`run`] that boots the Tauri 2
//! runtime with all plugins, application state and IPC commands wired up.
//! The actual feature work lives in submodules:
//!
//! - [`state`]    — `AppState` shared across all commands
//! - [`error`]    — `AppError` + `IntoResponse` glue for the IPC layer
//! - [`commands`] — Tauri command implementations grouped by domain
//!
//! Domain modules (`ssh`, `sftp`, `secrets`) are filled in over the milestones
//! described in `docs/ARCHITECTURE.md`.

pub mod commands;
pub mod db;
pub mod error;
pub mod known_hosts;
pub mod secrets;
pub mod sessions;
pub mod sftp;
pub mod ssh;
pub mod state;
pub mod sync;
pub mod themes;

use state::AppState;
use tauri::{Listener, Manager};

fn debug_log(msg: &str) {
    if let Some(desktop) = dirs::desktop_dir() {
        let _ = std::fs::OpenOptions::new()
            .create(true).append(true)
            .open(desktop.join("prossh-debug.log"))
            .and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "[{}] {msg}", chrono::Local::now().format("%H:%M:%S%.3f"))
            });
    }
}

/// On Linux, keyring-rs talks to the freedesktop Secret Service over DBus.
/// zbus looks up the session bus in this order:
///   1. `DBUS_SESSION_BUS_ADDRESS` env var
///   2. `$XDG_RUNTIME_DIR/bus`
/// If neither is set, zbus falls back to X11 autolaunch, which Arch (and
/// many other distros) disable at dbus build time — the user gets a
/// cryptic `Platform secure storage failure: DBus error: Using X11 for
/// dbus-daemon autolaunch was disabled at compile time` error and keyring
/// is effectively dead.
///
/// A surprisingly common Arch setup has those env vars empty in graphical
/// sessions (manual `startx` from tty, non-systemd init, broken PAM env
/// propagation, launching via older DMs, …) while `gnome-keyring-daemon`
/// *is* actually running on `/run/user/<uid>/bus`. Detect that case and
/// wire up the env vars ourselves before anything tries to use them.
#[cfg(target_os = "linux")]
fn hydrate_dbus_env() {
    use std::path::Path;

    fn current_uid() -> Option<u32> {
        // /proc/self/status: line "Uid:\t<real>\t<eff>\t<saved>\t<fs>"
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("Uid:") {
                return rest.split_whitespace().next()?.parse().ok();
            }
        }
        None
    }

    let Some(uid) = current_uid() else { return };
    let runtime_dir = format!("/run/user/{uid}");
    if !Path::new(&runtime_dir).is_dir() {
        return;
    }
    // MSRV-friendly: `Option::is_none_or` is 1.82-stable, we're on 1.80.
    let is_blank = |var: &str| {
        std::env::var_os(var).map_or(true, |v| v.is_empty())
    };
    if is_blank("XDG_RUNTIME_DIR") {
        std::env::set_var("XDG_RUNTIME_DIR", &runtime_dir);
        tracing::info!(dir = %runtime_dir, "hydrated XDG_RUNTIME_DIR");
    }
    if is_blank("DBUS_SESSION_BUS_ADDRESS") {
        let bus_path = format!("{runtime_dir}/bus");
        if Path::new(&bus_path).exists() {
            let addr = format!("unix:path={bus_path}");
            std::env::set_var("DBUS_SESSION_BUS_ADDRESS", &addr);
            tracing::info!(addr = %addr, "hydrated DBUS_SESSION_BUS_ADDRESS");
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn hydrate_dbus_env() {}

/// Boot the application — registers plugins, app state and command handlers.
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "prossh=info".into()),
        )
        .with_target(false)
        .compact()
        .init();

    // Must run before Tauri spawns worker threads — env mutation is racy
    // once other threads exist. keyring-rs is called from
    // tokio::task::spawn_blocking on the first connect attempt, which is
    // well after this point, so these vars will be in place by then.
    hydrate_dbus_env();

    tauri::Builder::default()
        // tauri-plugin-log is intentionally NOT registered: tracing_subscriber
        // already owns the global `log` facade. We'll add a JS-side log bridge
        // in a later step if needed.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Bring the existing window to focus when a second instance launches.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            let state = AppState::new(app.handle())?;

            // Write diagnostic info to a log file on the desktop so we can
            // debug path issues without a console window.
            if let Some(desktop) = dirs::desktop_dir() {
                let log = desktop.join("prossh-debug.log");
                let info = format!(
                    "data_dir  = {}\nconfig_dir = {}\nknown_hosts = {}\ndb = {}\n",
                    state.paths.data_dir.display(),
                    state.paths.config_dir.display(),
                    state.paths.known_hosts_path().display(),
                    state.paths.database_path().display(),
                );
                let _ = std::fs::write(&log, &info);
            }
            // Listen for host-key and passphrase resolve events.
            // We use events instead of invoke because invoke calls can be
            // serialised by WebView2 — the pending open_session invoke blocks
            // new invoke calls, creating a deadlock.
            {
                let hk_gate = state.host_key_gate.clone();
                app.listen("resolve-host-key", move |event: tauri::Event| {
                    let raw = event.payload();
                    debug_log(&format!("resolve-host-key event fired, raw payload: {raw}"));

                    #[derive(serde::Deserialize)]
                    struct Payload { prompt_id: Option<String>, accept: bool }
                    match serde_json::from_str::<Payload>(raw) {
                        Ok(p) => {
                            let accept = p.accept;
                            let gate = hk_gate.clone();
                            if let Some(id) = p.prompt_id {
                                debug_log(&format!("resolve-host-key: prompt_id={id}, accept={accept}"));
                                tokio::spawn(async move {
                                    let ok = crate::ssh::gate::resolve(&gate, &id, accept).await;
                                    debug_log(&format!("resolve-host-key: resolved by id={ok}"));
                                });
                            } else {
                                debug_log(&format!("resolve-host-key: no prompt_id, using resolve_any, accept={accept}"));
                                tokio::spawn(async move {
                                    let ok = crate::ssh::gate::resolve_any(&gate, accept).await;
                                    debug_log(&format!("resolve-host-key: resolve_any={ok}"));
                                });
                            }
                        }
                        Err(e) => {
                            debug_log(&format!("resolve-host-key PARSE ERROR: {e}"));
                        }
                    }
                });
            }
            {
                let pp_gate = state.passphrase_gate.clone();
                app.listen("resolve-passphrase", move |event: tauri::Event| {
                    let raw = event.payload();
                    debug_log(&format!("resolve-passphrase event fired, raw payload: {raw}"));

                    #[derive(serde::Deserialize)]
                    struct Payload { prompt_id: Option<String>, passphrase: String }
                    match serde_json::from_str::<Payload>(raw) {
                        Ok(p) => {
                            let passphrase = p.passphrase;
                            let gate = pp_gate.clone();
                            if let Some(id) = p.prompt_id {
                                debug_log(&format!("resolve-passphrase: prompt_id={id}"));
                                tokio::spawn(async move {
                                    crate::ssh::gate::resolve(&gate, &id, passphrase).await;
                                });
                            } else {
                                debug_log("resolve-passphrase: no prompt_id, using resolve_any");
                                tokio::spawn(async move {
                                    crate::ssh::gate::resolve_any(&gate, passphrase).await;
                                });
                            }
                        }
                        Err(e) => {
                            debug_log(&format!("resolve-passphrase PARSE ERROR: {e}"));
                        }
                    }
                });
            }

            {
                let cred_gate = state.credentials_gate.clone();
                app.listen("resolve-credentials", move |event: tauri::Event| {
                    let raw = event.payload();
                    debug_log(&format!("resolve-credentials event fired, raw payload: {raw}"));

                    #[derive(serde::Deserialize)]
                    struct Payload {
                        prompt_id: Option<String>,
                        username: String,
                        password: String,
                    }
                    match serde_json::from_str::<Payload>(raw) {
                        Ok(p) => {
                            let resp = crate::ssh::pty::CredentialsResponse {
                                username: p.username,
                                password: p.password,
                            };
                            let gate = cred_gate.clone();
                            if let Some(id) = p.prompt_id {
                                debug_log(&format!("resolve-credentials: prompt_id={id}"));
                                tokio::spawn(async move {
                                    crate::ssh::gate::resolve(&gate, &id, resp).await;
                                });
                            } else {
                                debug_log("resolve-credentials: no prompt_id, using resolve_any");
                                tokio::spawn(async move {
                                    crate::ssh::gate::resolve_any(&gate, resp).await;
                                });
                            }
                        }
                        Err(e) => {
                            debug_log(&format!("resolve-credentials PARSE ERROR: {e}"));
                        }
                    }
                });
            }

            // If the user previously opted into "Remember on this device",
            // pick the master passphrase out of the secret backend and spawn
            // the auto-sync loop with the cached interval. Failures here are
            // non-fatal — sync just stays paused until the user re-enters
            // their passphrase in Settings → Sync.
            if let Some(pass) = crate::sync::restore_passphrase() {
                state.sync_runtime.set_passphrase(pass);
            }
            {
                let conn = state.db.conn.clone();
                let runtime = state.sync_runtime.clone();
                let app_handle = app.handle().clone();
                if let Err(e) = crate::sync::start_auto_sync(conn, runtime, app_handle) {
                    tracing::warn!(error = %e, "failed to start auto-sync at boot");
                }
            }

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::misc::ping,
            commands::misc::app_version,
            commands::sessions::sessions_list,
            commands::sessions::sessions_upsert,
            commands::sessions::sessions_delete,
            commands::sessions::sessions_dedup,
            commands::sessions::groups_list,
            commands::sessions::groups_upsert,
            commands::sessions::groups_delete,
            commands::sessions::import_ssh_config,
            commands::sessions::import_putty_sessions,
            commands::sessions::import_moba_sessions,
            commands::sessions::import_moba_file,
            commands::secrets::secrets_set,
            commands::secrets::secrets_has,
            commands::secrets::secrets_clear,
            commands::secrets::secrets_copy,
            commands::secrets::secrets_backend_status,
            commands::secrets::secrets_set_backend,
            commands::secrets::secrets_vault_create,
            commands::secrets::secrets_vault_unlock,
            commands::secrets::secrets_vault_lock,
            commands::secrets::secrets_vault_change_password,
            commands::secrets::secrets_vault_destroy,
            commands::known_hosts::known_hosts_list,
            commands::known_hosts::known_hosts_remove,
            commands::known_hosts::known_hosts_clear_host,
            commands::ssh::ssh_test_connect,
            commands::ssh::ssh_detect_os,
            commands::pty::open_session,
            commands::pty::write_to_pty,
            commands::pty::resize_pty,
            commands::pty::close_session,
            commands::pty::resolve_passphrase,
            commands::pty::resolve_host_key,
            commands::settings::color_profiles_list,
            commands::settings::color_profiles_upsert,
            commands::settings::color_profiles_delete,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::sftp::sftp_open,
            commands::sftp::sftp_close,
            commands::sftp::sftp_list,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rmdir,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_touch,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_download,
            commands::sftp::sftp_read_text,
            commands::sftp::sftp_write_text,
            commands::sftp::sftp_chmod,
            commands::sftp::sftp_server_copy,
            commands::sftp::ssh_remote_exec,
            commands::sftp::ssh_remote_exec_stream,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::prepare_server_copy_auth,
            commands::sftp::cleanup_server_copy_auth,
            commands::sftp::sftp_download_temp,
            commands::sftp::sftp_download_for_edit,
            commands::sftp::file_mtime,
            commands::sftp::open_in_default_app,
            commands::sftp::local_list,
            commands::sftp::local_home,
            commands::system::remote_stats,
            commands::system::remote_stats_fast,
            commands::system::remote_stats_slow,
            commands::scripts::scripts_list,
            commands::scripts::scripts_list_global,
            commands::scripts::scripts_list_for_session,
            commands::scripts::scripts_upsert,
            commands::scripts::scripts_delete,
            commands::sessions::port_forwards_list,
            commands::sessions::port_forwards_upsert,
            commands::sessions::port_forwards_delete,
            commands::sync::sync_status,
            commands::sync::sync_config_get,
            commands::sync::sync_config_set,
            commands::sync::sync_oauth_connect,
            commands::sync::sync_oauth_disconnect,
            commands::sync::sync_push,
            commands::sync::sync_pull,
            commands::sync::sync_export_file,
            commands::sync::sync_import_file,
            commands::sync::sync_passphrase_set,
            commands::sync::sync_passphrase_clear,
            commands::sync::sync_auto_interval_set,
            commands::sync::sync_auto_run_now,
        ])
        .build(tauri::generate_context!())
        .expect("error while building prossh")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = &event {
                // Gracefully disconnect all live SSH sessions before the
                // process exits. We spawn a blocking runtime for the async
                // teardown since we're on the main (event) thread here.
                let state: tauri::State<AppState> = app.state();
                let map = state.ssh_sessions.clone();
                // Best-effort: give sessions 3s to disconnect gracefully.
                let _ = tokio::runtime::Handle::try_current().map(|rt| {
                    rt.block_on(async {
                        tokio::time::timeout(
                            std::time::Duration::from_secs(3),
                            ssh::pty::close_all(&map),
                        )
                        .await
                        .ok();
                    });
                });
            }
        });
}
