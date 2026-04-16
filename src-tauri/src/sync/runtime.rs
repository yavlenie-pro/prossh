//! In-memory runtime state for sync — outlives individual commands so the
//! auto-sync loop can reuse the user's cached passphrase and the frontend
//! doesn't need to re-prompt on every tick.
//!
//! Lives in [`crate::state::AppState`].

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::async_runtime::JoinHandle;

/// Shared sync state. Cheap to clone (wraps everything in `Arc<Mutex<_>>`).
#[derive(Default)]
pub struct SyncRuntime {
    /// Master passphrase the user entered in the setup / push dialog. Kept
    /// in RAM so the auto-sync loop can encrypt/decrypt without re-prompting.
    /// Cleared on disconnect or explicit wipe.
    cached_passphrase: Mutex<Option<String>>,
    /// Handle of the currently-running auto-sync task, if any. Holding it
    /// lets us `abort()` and relaunch when the interval changes.
    auto_task: Mutex<Option<JoinHandle<()>>>,
}

impl SyncRuntime {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn set_passphrase(&self, pass: String) {
        *self.cached_passphrase.lock() = Some(pass);
    }

    pub fn clear_passphrase(&self) {
        *self.cached_passphrase.lock() = None;
    }

    pub fn passphrase(&self) -> Option<String> {
        self.cached_passphrase.lock().clone()
    }

    pub fn has_passphrase(&self) -> bool {
        self.cached_passphrase.lock().is_some()
    }

    /// Replace the task handle, aborting any previous one. Used when the
    /// interval changes so we don't leak tasks.
    pub fn install_task(&self, handle: JoinHandle<()>) {
        if let Some(h) = self.auto_task.lock().replace(handle) {
            h.abort();
        }
    }

    /// Abort the running task, if any. Safe to call at any time.
    pub fn abort_task(&self) {
        if let Some(h) = self.auto_task.lock().take() {
            h.abort();
        }
    }
}
