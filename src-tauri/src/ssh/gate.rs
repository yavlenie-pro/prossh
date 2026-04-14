//! Prompt gates — oneshot channels for user-input that blocks SSH flows.
//!
//! When the backend needs a passphrase (or later a host-key decision) it
//! parks on a oneshot receiver while the frontend shows a dialog. The
//! `resolve_*` IPC commands send the user's answer through the sender half.
//!
//! Each pending prompt is keyed by a `prompt_id` (a UUID) so multiple
//! concurrent sessions can be in the "waiting for user" state simultaneously
//! without conflicting.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{oneshot, RwLock};

/// A pending prompt waiting for a user response.
pub type PromptMap<T> = Arc<RwLock<HashMap<String, oneshot::Sender<T>>>>;

pub fn new_prompt_map<T>() -> PromptMap<T> {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Register a new prompt and return the receiver + prompt_id.
pub async fn register<T>(map: &PromptMap<T>) -> (String, oneshot::Receiver<T>) {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    map.write().await.insert(id.clone(), tx);
    (id, rx)
}

/// Resolve a prompt by sending the user's answer. Returns `false` if the
/// prompt was already resolved or not found (e.g. timed out).
pub async fn resolve<T>(map: &PromptMap<T>, id: &str, value: T) -> bool {
    if let Some(tx) = map.write().await.remove(id) {
        tx.send(value).is_ok()
    } else {
        false
    }
}

/// Resolve **any** single pending prompt (the first found).
/// Used as a fallback when the frontend doesn't send a `prompt_id`.
pub async fn resolve_any<T>(map: &PromptMap<T>, value: T) -> bool {
    let mut guard = map.write().await;
    if let Some(key) = guard.keys().next().cloned() {
        if let Some(tx) = guard.remove(&key) {
            return tx.send(value).is_ok();
        }
    }
    false
}
